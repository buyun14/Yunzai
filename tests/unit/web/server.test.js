import http from "node:http"
import express from "express"
import { afterEach, describe, expect, it, vi } from "vitest"
import { API_PREFIX, UI_PREFIX, WebUI } from "../../../lib/web/server.js"

/**
 * 挂载门卫与就绪语义的测试。
 *
 * 全部走**真实 HTTP**：这一块的价值就在于"中间件真的挂在链上、顺序真的对"，
 * 而这两件事单测中间件本身证明不了。阶段 5 的 `config:diff` 已经证明了
 * "单测覆盖不到顶层控制流"会漏掉什么。
 */

/** 已启动的临时服务，`afterEach` 统一关掉（否则 vitest 会因为句柄未释放而不退出） */
const servers = []

/**
 * 发起一次真实请求。
 *
 * 用 `node:http` 而不是 `fetch`：需要精确控制请求头，特别是**不带**
 * `Content-Length` 的请求（`fetch` 表达不了 chunked）。
 *
 * @param {string} base 服务地址
 * @param {string} path 路径
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts] 选项
 * @returns {Promise<{ status: number, headers: Record<string, unknown>, text: string }>} 响应
 */
function request(base, path, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path, method, headers },
      res => {
        let text = ""
        res.on("data", chunk => (text += chunk))
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text: String(text) }),
        )
      },
    )
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 起一个临时服务并返回地址。端口 0 = 由内核分配，避免撞上开发中的实例（2536）。
 *
 * @param {import("express").Express} app 应用
 * @returns {Promise<string>} 服务地址
 */
async function serve(app) {
  const server = app.listen(0, "127.0.0.1")
  await new Promise(resolve => server.once("listening", resolve))
  servers.push(server)
  return `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise(resolve => {
          server.closeAllConnections?.()
          server.close(resolve)
        }),
    ),
  )
})

/**
 * 造一个 WebUI 实例，外加一个会把日志记下来的宿主替身。
 *
 * @param {{ enable?: boolean, auth?: Record<string, string>, online?: number, address?: string }} [opts] 选项
 * @returns {{ webui: WebUI, host: { logs: unknown[][], makeLog: Function } }} 实例与宿主替身
 */
function makeWebUI({ enable = true, auth = { Authorization: "t" }, online = 2, address } = {}) {
  /** @type {{ logs: unknown[][], makeLog: Function }} */
  const host = { logs: [], makeLog: (...args) => host.logs.push(args) }
  const webui = new WebUI({
    cfg: { webui: { enable }, server: { auth, address } },
    onlineOf: () => online,
    hostOf: () => host,
  })
  return { webui, host }
}

/**
 * 造一个"宿主应用"，中间件顺序与 `lib/bot.js` 一致。
 *
 * 兜底用 418 而不是 404：这样能一眼区分"是 WebUI 答复的"还是"漏到宿主了"。
 *
 * @param {WebUI} webui 实例
 * @returns {import("express").Express} 应用
 */
function hostApp(webui) {
  const app = express()
  app.use(webui.earlyProbe.bind(webui))
  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())
  app.use(express.raw())
  app.use(express.text())
  webui.mount(app)
  app.use((req, res) => res.status(418).send("宿主兜底"))
  return app
}

describe("挂载门卫：默认关闭", () => {
  it("未启用时不挂载，请求落到宿主的兜底", async () => {
    const { webui } = makeWebUI({ enable: false })
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/ready`)
    expect(res.status).toBe(418)
  })

  it("未启用时一条日志都不打（默认配置下行为与改造前逐字一致）", async () => {
    const { webui, host } = makeWebUI({ enable: false })
    const url = await serve(hostApp(webui))

    await request(url, `${API_PREFIX}/ready`)
    await request(url, `${UI_PREFIX}/`)
    expect(host.logs).toEqual([])
  })
})

describe("挂载门卫：启用但鉴权未配置", () => {
  it("拒绝挂载，且日志给出可照抄的配置指引", async () => {
    const { webui, host } = makeWebUI({ auth: {} })
    const app = hostApp(webui)

    const result = webui.mount(app)
    expect(result).toEqual({ mounted: false, reason: "no-auth" })

    const text = JSON.stringify(host.logs)
    expect(text).toContain("server.auth 为空")
    expect(text).toContain("config/config/server.yaml")
    expect(text).toContain("Authorization: Bearer")

    const url = await serve(app)
    expect((await request(url, `${API_PREFIX}/ready`)).status).toBe(418)
  })

  it("auth 整个键都不存在时同样拒绝（旧配置里没有这个键）", () => {
    // 不能走 makeWebUI：它的默认参数会把 undefined 换成默认值，那样测的就不是缺失了
    const webui = new WebUI({
      cfg: { webui: { enable: true }, server: { address: "127.0.0.1" } },
      onlineOf: () => 2,
      hostOf: () => ({ makeLog() {} }),
    })
    expect(webui.hasAuth).toBe(false)
    expect(webui.mount(express())).toEqual({ mounted: false, reason: "no-auth" })
  })
})

describe("挂载门卫：启用且已配置鉴权", () => {
  it("挂载成功，就绪探针返回 JSON", async () => {
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/ready`)
    expect(res.status).toBe(200)
    expect(String(res.headers["content-type"])).toContain("application/json")
    expect(JSON.parse(res.text)).toMatchObject({ ready: true, online: 2 })
  })

  it("未命中的接口返回 JSON 404，而不是落到宿主的兜底", async () => {
    const { webui } = makeWebUI()
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/nope`)
    expect(res.status).toBe(404)
    expect(JSON.parse(res.text).code).toBe("not_found")
  })

  it("mount 幂等：重复挂载不会把中间件叠两遍", async () => {
    const { webui } = makeWebUI()
    const app = hostApp(webui)

    expect(webui.mount(app)).toEqual({ mounted: true, reason: "already" })
    const url = await serve(app)
    expect((await request(url, `${API_PREFIX}/ready`)).status).toBe(200)
  })

  it("address 未配置时提示监听地址（只提示，不改行为）", () => {
    const { webui, host } = makeWebUI()
    webui.mount(express())

    const warn = host.logs.find(args => args[0] === "warn")
    expect(JSON.stringify(warn)).toContain("127.0.0.1")
  })
})

describe("就绪语义：启动期不能挂起", () => {
  it("未上线时 /api/v1/* 返回 503 + Retry-After，而不是一直等", async () => {
    const { webui } = makeWebUI({ online: 1 })
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/ready`)
    expect(res.status).toBe(503)
    expect(res.headers["retry-after"]).toBe("2")
    expect(JSON.parse(res.text).code).toBe("starting")
  })

  it("未上线时 /dashboard 返回可自动重试的提示页", async () => {
    const { webui } = makeWebUI({ online: 0 })
    const url = await serve(hostApp(webui))

    const res = await request(url, `${UI_PREFIX}/`)
    expect(res.status).toBe(503)
    expect(String(res.headers["content-type"])).toContain("text/html")
    expect(res.text).toContain("正在启动")
  })

  it("未上线时**只拦这两个前缀**：既有路径照旧走宿主链路", async () => {
    const { webui } = makeWebUI({ online: 1 })
    const url = await serve(hostApp(webui))

    for (const path of ["/status", "/exit", "/File", "/anything"]) {
      const res = await request(url, path)
      expect([418], `路径 ${path} 被早期探针拦了`).toContain(res.status)
    }
  })

  it("未启用 WebUI 时即使未上线也纯透传", async () => {
    const { webui } = makeWebUI({ enable: false, online: 0 })
    const url = await serve(hostApp(webui))

    expect((await request(url, `${API_PREFIX}/ready`)).status).toBe(418)
    expect((await request(url, `${UI_PREFIX}/`)).status).toBe(418)
  })
})

describe("默认依赖：不注入时读全局 Bot", () => {
  it("onlineOf 缺省读 globalThis.Bot.stat.online（与 lib/bot.js 的接线一致）", () => {
    // tests/helpers/env.js 装的 Bot 替身 stat.online 是 2
    const webui = new WebUI({ cfg: { webui: { enable: true }, server: { auth: { A: "t" } } } })
    let passed = false
    // 就绪状态下探针直接放行，不会碰 res
    webui.earlyProbe({ originalUrl: `${API_PREFIX}/ready` }, {}, () => (passed = true))
    expect(passed).toBe(true)
  })

  it("宿主没有 makeLog 时退回 console，而不是把配置错误吞掉", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const webui = new WebUI({
        cfg: { webui: { enable: true }, server: {} },
        onlineOf: () => 2,
        hostOf: () => ({}),
      })
      webui.mount(express())
      expect(spy).toHaveBeenCalled()
      expect(JSON.stringify(spy.mock.calls)).toContain("server.auth 为空")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("安全中间件确实挂在链上", () => {
  it("没有 Content-Length 的 multipart 返回 411", async () => {
    const { webui } = makeWebUI()
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/ready`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: "--x\r\n", // 不设 content-length → node 用 chunked
    })
    expect(res.status).toBe(411)
    expect(JSON.parse(res.text).code).toBe("length_required")
  })

  it("超过解析器上限的请求体变成 413 JSON，而不是一个空的 200", async () => {
    const { webui } = makeWebUI()
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/ready`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(200 * 1024), // express.text() 默认上限 100KB
    })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.text).code).toBe("payload_too_large")
  })

  it("坏 JSON 返回 400 JSON", async () => {
    const { webui } = makeWebUI()
    const url = await serve(hostApp(webui))

    const res = await request(url, `${API_PREFIX}/ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.text).code).toBe("bad_request")
  })

  it("上游抛出的带状态码的错误被映射成 JSON，而不是宿主的空响应", async () => {
    const { webui } = makeWebUI()
    const app = express()
    app.use(webui.earlyProbe.bind(webui))
    // 模拟链上更早的一层（如适配器注册的路由）抛错
    app.use(`${API_PREFIX}/boom`, (req, res, next) =>
      next(Object.assign(new Error("坏掉了"), { status: 403 })),
    )
    webui.mount(app)
    app.use((req, res) => res.status(418).send("宿主兜底"))

    const res = await request(await serve(app), `${API_PREFIX}/boom`)
    expect(res.status).toBe(403)
    expect(JSON.parse(res.text).message).toBe("坏掉了")
  })

  it("限流生效：被持续打时会返回 429 + Retry-After", async () => {
    const { webui } = makeWebUI()
    const url = await serve(hostApp(webui))

    // 不能断言"第 61 次必被拦"：默认桶容量 60，但回填是按真实时间走的，
    // 循环本身花掉的时间会补进令牌（实测 61 次约 120ms ≈ 1 个令牌）。
    // 所以这里断言的是**性质**：持续打下去一定会被拦，且拦的时候带重试提示。
    let blocked
    for (let i = 0; i < 300 && !blocked; i++) {
      const res = await request(url, `${API_PREFIX}/ready`)
      if (res.status === 429) blocked = res
    }

    expect(blocked, "连打 300 次都没触发限流").toBeDefined()
    expect(JSON.parse(blocked.text).code).toBe("rate_limited")
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1)
  })
})
