import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
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

/** `makeFakeDist()` 造的临时目录，`afterEach` 一并删掉 */
const tempDirs = []

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
  // 临时目录删失败不该让用例变红（Windows 上偶尔会被杀毒/索引占用），
  // 但也不能静默：真删不掉时把它写进 stderr，至少留下线索
  for (const dir of tempDirs.splice(0))
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.error("临时目录没删掉：", dir, err)
    }
})

/**
 * 造一个 WebUI 实例，外加一个会把日志记下来的宿主替身。
 *
 * 注意配置形状：开关在 `server.yaml` 的嵌套键里，即 `cfg.server.webui.enable`。
 *
 * @param {{ enable?: boolean, auth?: Record<string, string>, online?: number, address?: string }} [opts] 选项
 * @returns {{ webui: WebUI, host: { logs: unknown[][], makeLog: Function } }} 实例与宿主替身
 */
function makeWebUI({ enable = true, auth = { Authorization: "t" }, online = 2, address } = {}) {
  /** @type {{ logs: unknown[][], makeLog: Function }} */
  const host = { logs: [], makeLog: (...args) => host.logs.push(args) }
  const webui = new WebUI({
    cfg: { server: { webui: { enable }, auth, address } },
    onlineOf: () => online,
    hostOf: () => host,
  })
  return { webui, host }
}

/**
 * 造一个"宿主应用"，中间件顺序与 `lib/bot.js` 一致。
 *
 * 兜底用 418 而不是 404：这样能一眼区分"是 WebUI 答复的"还是"漏到宿主了"。
 * 兜底**永远最后挂**（含 `auth` 时也是），否则它会抢在鉴权检查前面把请求答掉。
 *
 * @param {WebUI} webui 实例
 * @param {{ distDir?: string, auth?: Record<string, string> }} [opts] 选项
 * @returns {import("express").Express} 应用
 */
function hostApp(webui, { distDir, auth } = {}) {
  const app = express()
  // 与 lib/bot.js 一致：`skip_auth` 是挂在 express 应用上的数组，
  // WebUI 挂载时会往里追加静态资源前缀
  app.skip_auth = []
  app.use(webui.earlyProbe.bind(webui))
  // 与 lib/bot.js 一致的顺序：**早期探针 → WebUI 前端 → serverAuth**。
  // 前端**挂在根上**、自己判断 `/dashboard` 前缀：实测 `app.use(UI_PREFIX, …)`
  // 这一层在 express 5 下不被匹配，请求会直接挂住（详见 lib/web/server.js）。
  app.use(webui.frontend({ distDir, skipAuth: app.skip_auth }))

  // 复刻 `lib/bot.js` 的 `serverAuth` 里与本议题相关的部分：
  // `skip_auth` 前缀放行（`startsWith`），否则要求头名与令牌都对上。
  if (auth)
    app.use((req, res, next) => {
      for (const prefix of app.skip_auth || [])
        if (req.originalUrl.startsWith(prefix)) return next()
      for (const name in auth) if (req.headers[name.toLowerCase()] === auth[name]) return next()
      res.status(401).type("text").send("Unauthorized")
    })

  app.use(express.urlencoded({ extended: false }))
  app.use(express.json())
  app.use(express.raw())
  app.use(express.text())
  webui.mount(app, { distDir })
  app.use((req, res) => res.status(418).send("宿主兜底"))
  return app
}

/**
 * 造一个**看起来像**构建产物的目录。
 *
 * 静态挂载的行为只能用真实的文件系统验：`express.static` 的
 * 目录/回退/未命中语义都发生在它内部，mock 掉就等于没测。
 *
 * @returns {string} 临时目录（`afterEach` 一并清掉）
 */
function makeFakeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yz-dashboard-"))
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true })
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>面板入口</title>")
  fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log('panel')")
  tempDirs.push(dir)
  return dir
}

describe("挂载门卫：配置键空间", () => {
  it("从 server.yaml 的嵌套键读开关", () => {
    const { webui } = makeWebUI()
    expect(webui.enabled).toBe(true)
  })

  it("写成顶层 cfg.webui 时不生效 —— 那会去找 config/config/webui.yaml", () => {
    // 这个用例防的是一次真实踩过的错：`cfg.<名字>` 映射的是**文件**而不是嵌套键。
    // 写成 cfg.webui.enable 时，它会去找一个不存在的 webui.yaml，读到 undefined，
    // 于是面板永不启用而没有任何报错——静默失败，比报错难查得多。
    const webui = new WebUI({
      cfg: /** @type {any} */ ({ webui: { enable: true }, server: { auth: { A: "t" } } }),
    })
    expect(webui.enabled).toBe(false)
  })
})

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
    // 用 toMatchObject 而不是 toEqual：`mount()` 还会回一个 `frontend` 字段
    // （"dist" / "missing"），那条信息只给调用方看，不该让这条门卫用例跟着变
    expect(result).toMatchObject({ mounted: false, reason: "no-auth" })

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
      cfg: { server: { webui: { enable: true }, address: "127.0.0.1" } },
      onlineOf: () => 2,
      hostOf: () => ({ makeLog() {} }),
    })
    expect(webui.hasAuth).toBe(false)
    expect(webui.mount(express())).toMatchObject({ mounted: false, reason: "no-auth" })
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

    expect(webui.mount(app)).toMatchObject({ mounted: true, reason: "already" })
    const url = await serve(app)
    expect((await request(url, `${API_PREFIX}/ready`)).status).toBe(200)
  })

  it("address 未配置时提示监听地址（只提示，不改行为）", () => {
    const { webui, host } = makeWebUI()
    webui.mount(express())

    // 按**内容**定位，不按「第一条 warn」定位：挂载路径上不止一条 warn
    // （前端没构建时也会 warn），按下标取会随无关改动而红
    const warn = host.logs.find(
      args => args[0] === "warn" && JSON.stringify(args).includes("server.address"),
    )
    expect(warn, "没有提示监听地址").toBeDefined()
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
    const webui = new WebUI({ cfg: { server: { webui: { enable: true }, auth: { A: "t" } } } })
    let passed = false
    // 就绪状态下探针直接放行，不会碰 res
    webui.earlyProbe({ originalUrl: `${API_PREFIX}/ready` }, {}, () => (passed = true))
    expect(passed).toBe(true)
  })

  it("宿主没有 makeLog 时退回 console，而不是把配置错误吞掉", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const webui = new WebUI({
        cfg: { server: { webui: { enable: true }, auth: {} } },
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

  it("未预期的错误返回 500 JSON（不是宿主 serverError 的空 200）", async () => {
    const { webui } = makeWebUI()
    const app = express()
    app.use(webui.earlyProbe.bind(webui))
    app.use(`${API_PREFIX}/boom`, (req, res, next) => next(new Error("没预料到的")))
    webui.mount(app)
    app.use((req, res) => res.status(418).send("宿主兜底"))

    const res = await request(await serve(app), `${API_PREFIX}/boom`)
    expect(res.status).toBe(500)
    expect(JSON.parse(res.text)).toMatchObject({ code: "internal_error", message: "没预料到的" })

    // 错误也进了宿主的日志，否则排查时什么都看不到。
    // 断言用 String(err) 而不是 JSON.stringify —— Error 的可枚举属性是空的
    const logged = globalThis.Bot.logs.at(-1)
    expect(logged[1][0]).toBe("WebUI API 错误")
    expect(String(logged[1][1])).toContain("没预料到的")
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

describe("前端静态资源", () => {
  it("接上真实鉴权后 /dashboard/ 仍能打开 —— 浏览器没法给文档请求带自定义头", async () => {
    // 这是**真机跳出来的坑**（2026-09-24）：第一版只把 `/dashboard/assets` 放进了
    // `skip_auth`，而入口文档走的是 `serverAuth` —— 结果 assets 200、`/dashboard/` 401，
    // 面板压根打不开。前面的用例都直接请求 assets 与 API，从不请求面板根路径，
    // 所以这个组合在接入鉴权的测试之前是**测不出来**的。
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const auth = { Authorization: "t" }
    const url = await serve(hostApp(webui, { distDir: makeFakeDist(), auth }))

    // `/dashboard`（不带斜杠）由 express 的挂载语义 301 到 `/dashboard/`，
    // 浏览器会自动跟随——所以真正要求 200 的是带斜杠的那个形状。
    const res = await request(url, `${UI_PREFIX}/`)
    expect(res.status, `${UI_PREFIX}/ 应当免鉴权放行（浏览器拿不到令牌）`).toBe(200)
    expect(res.text).toContain("面板入口")

    // 资源也必须免鉴权（<script> / <link> 同样带不了头）
    expect((await request(url, `${UI_PREFIX}/assets/index-abc123.js`)).status).toBe(200)
  })

  it("免鉴权只覆盖入口文档与 assets：其余 /dashboard/** 仍要令牌", async () => {
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const auth = { Authorization: "t" }
    const url = await serve(hostApp(webui, { distDir: makeFakeDist(), auth }))

    // `/dashboard` 是适配器可以注册路径的地方。把整个前缀放进 skip_auth
    // 会连别人的路由一起放宽，所以这一层刻意只认两个形状。
    const other = await request(url, `${UI_PREFIX}/whatever`)
    expect(other.status).toBe(401)

    // API 一律要令牌
    expect((await request(url, `${API_PREFIX}/status`)).status).toBe(401)
    expect(
      (await request(url, `${API_PREFIX}/status`, { headers: auth })).status,
      "带对了令牌就该通过",
    ).toBe(200)
  })

  it("挂载 dist 后 /dashboard/ 回 index.html、/dashboard/assets/* 回真实文件", async () => {
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const dist = makeFakeDist()
    const url = await serve(hostApp(webui, { distDir: dist }))

    const index = await request(url, `${UI_PREFIX}/`)
    expect(index.status).toBe(200)
    expect(index.text).toContain("面板入口")

    const asset = await request(url, `${UI_PREFIX}/assets/index-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.text).toContain("panel")
  })

  it("把 /dashboard/assets 追加进 skip_auth —— 否则 <script> 一律 401、面板白屏", async () => {
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const app = hostApp(webui, { distDir: makeFakeDist() })

    // 这是本节的**唯一**鉴权例外，只放静态资源；
    // 它必须是一个前缀判断（宿主 serverAuth 用的是 startsWith）
    expect(app.skip_auth).toContain(`${UI_PREFIX}/assets`)
    // 面板本身与 API **不**放行
    expect(app.skip_auth).not.toContain(UI_PREFIX)
    expect(app.skip_auth).not.toContain(API_PREFIX)
  })

  it("dist 里没有 index.html 时只打 warn，API 照常可用", async () => {
    const { webui, host } = makeWebUI({ address: "127.0.0.1" })
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "yz-dashboard-empty-"))
    tempDirs.push(empty)

    const url = await serve(hostApp(webui, { distDir: empty }))

    const warn = host.logs.find(
      args => args[0] === "warn" && String(args[1][0]).includes("还没构建"),
    )
    expect(warn, "没构建前端时必须留下一条能看懂的 warn").toBeDefined()
    // 关键：面板没构建**不该**让 API 跟着不可用
    expect((await request(url, `${API_PREFIX}/ready`)).status).toBe(200)
  })

  it("非根路径不落到 SPA 回退，交给宿主的兜底", async () => {
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const url = await serve(hostApp(webui, { distDir: makeFakeDist() }))

    // 面板是 hash 路由（见 dashboard/src/router），入口只有 index.html 一个，
    // 所以没有"任意路径都回 index"的 history 回退——那会把宿主原有路径吃掉
    expect((await request(url, `${UI_PREFIX}/whatever`)).status).toBe(418)
  })

  it("未挂载前端时 /dashboard/ 仍由早期探针/兜底处理（不受静态挂载影响）", async () => {
    const { webui } = makeWebUI({ enable: false })
    const url = await serve(hostApp(webui, { distDir: makeFakeDist() }))

    // 未启用时连静态资源都不该挂
    expect((await request(url, `${UI_PREFIX}/`)).status).toBe(418)
    expect((await request(url, `${UI_PREFIX}/assets/index-abc123.js`)).status).toBe(418)
  })
})

describe("回归：既有路由不受 WebUI 影响", () => {
  it("启用 WebUI 时 /status、/File、/exit 仍由原本的处理器答复", async () => {
    const { webui } = makeWebUI({ address: "127.0.0.1" })
    const app = express()
    app.use(webui.earlyProbe.bind(webui))
    // 与 lib/bot.js 一致：三个既有路由挂在早期探针之后、WebUI 挂载点之前
    app.use("/status", (req, res) => res.type("json").send('{"report":true}'))
    app.use("/File", (req, res) => res.send("file-body"))
    app.use("/exit", (req, res) => res.send("exited"))
    webui.mount(app, { loader: { priority: [] } })
    // 宿主的兜底跳转（run() 里最后加的那一层）
    app.use((req, res) => res.redirect("https://git.trss.me/Yunzai"))

    const url = await serve(app)
    expect((await request(url, "/status")).text).toBe('{"report":true}')
    expect((await request(url, "/File")).text).toBe("file-body")
    expect((await request(url, "/exit")).text).toBe("exited")

    // 同时面板路径可用（两者共存，互不遮蔽）
    const api = await request(url, `${API_PREFIX}/status`)
    expect(api.status).toBe(200)
    expect(JSON.parse(api.text).plugins).toEqual({ handlers: 0, loaded: 0, tasks: 0 })

    // 其余路径仍然走宿主的兜底跳转
    expect((await request(url, "/whatever")).status).toBe(302)
  })
})
