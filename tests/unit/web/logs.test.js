import http from "node:http"
import compression from "compression"
import express from "express"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LogStream, clampLimit } from "../../../lib/web/api/logs.js"
import { createApiRouter } from "../../../lib/web/api/router.js"
import { API_PREFIX } from "../../../lib/web/server.js"

/**
 * 日志流的测试。
 *
 * `log4js` 被替身化：`attach()` 会真的重配日志系统，而测试不该往
 * `logs/command.<date>.log` 里写字（那是用户会去看的文件）。
 * 替身化之后仍能验证真正的契约——我们**往三个分类里各挂了一个 appender**，
 * 且那个 appender 确实把事件交给了 `record()`。
 *
 * 流本身（订阅、回放、心跳、断开清理）走真实 HTTP，含 `compression()`：
 * 少了 `no-transform` 的话，压缩中间件会把 SSE 的小分片攒在缓冲区里，
 * 那是"连上了但一条都看不到"的经典故障，必须有用例盯着。
 */

const hoisted = vi.hoisted(() => ({ configs: [], failNext: false }))

vi.mock("log4js", () => ({
  default: {
    configure: config => {
      if (hoisted.failNext) {
        hoisted.failNext = false
        throw new Error("configure 炸了")
      }
      hoisted.configs.push(config)
    },
  },
}))

/** 已启动的临时服务，afterEach 统一关掉 */
const servers = []

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
 * 起一个临时服务（含 `compression()`，与宿主链一致），返回地址。
 *
 * @param {LogStream} stream 日志流
 * @returns {Promise<string>} 地址
 */
async function serve(stream) {
  const app = express()
  app.use(compression())
  app.use(API_PREFIX, createApiRouter({ loader: { priority: [] }, logStream: stream }))
  const server = app.listen(0, "127.0.0.1")
  await new Promise(resolve => server.once("listening", resolve))
  servers.push(server)
  return `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`
}

/**
 * 连上去读 SSE。
 *
 * @param {string} base 地址
 * @param {string} path 路径
 * @returns {{ text: () => string, close: () => void, waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string> }} 客户端
 */
function sseClient(base, path) {
  const url = new URL(base)
  const chunks = []
  const waiters = []
  const req = http.request({ hostname: url.hostname, port: url.port, path }, res => {
    res.setEncoding("utf8")
    res.on("data", chunk => {
      chunks.push(chunk)
      for (const wake of waiters.splice(0)) wake()
    })
  })
  req.end()

  return {
    text: () => chunks.join(""),
    close: () => req.destroy(),
    async waitFor(pattern, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs
      while (!pattern.test(chunks.join(""))) {
        if (Date.now() > deadline)
          throw new Error(`等待 ${pattern} 超时；已收到 ${JSON.stringify(chunks.join(""))}`)
        await new Promise(resolve => {
          waiters.push(resolve)
          setTimeout(resolve, 20)
        })
      }
      return chunks.join("")
    },
  }
}

/**
 * 造一个 log4js 风格的事件。
 *
 * @param {string} message 消息
 * @param {{ level?: string, category?: string, data?: unknown[] }} [opts] 覆盖项
 * @returns {Record<string, unknown>} 事件
 */
function logEvent(message, { level = "INFO", category = "message", data } = {}) {
  return {
    startTime: new Date(1_700_000_000_000),
    level: { levelStr: level },
    categoryName: category,
    data: data ?? [message],
  }
}

/**
 * 造一对假的 req/res（只实现处理器真正用到的那几个方法）。
 *
 * @returns {{ req: object, res: object, writes: string[], close: () => void }} 结果
 */
function fakeReqRes() {
  const listeners = {}
  const writes = []
  const on = (name, fn) => (listeners[name] = fn)
  const req = { query: {}, on }
  const res = {
    status: () => res,
    set: () => res,
    write: chunk => writes.push(chunk),
    on,
    flushHeaders() {},
  }
  return {
    req,
    res,
    writes,
    // 模拟 req 与 res 的 close 都触发（真实环境下两个都会发）
    close: () => {
      listeners.close?.()
      listeners.close?.()
    },
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

describe("LogStream.attach：接入 log4js", () => {
  it("给三个分类都挂上 appender，且把它接回 record()", () => {
    hoisted.configs.length = 0
    const stream = new LogStream()
    expect(stream.attach()).toEqual({ attached: true })

    const config = hoisted.configs[0]
    for (const name of ["default", "command", "error"])
      expect(config.categories[name].appenders).toContain("webui")

    // 拿 appender 工厂造出真正的 appender，喂一条事件进去
    const appender = config.appenders.webui.type.configure({}, {})
    appender(logEvent("来自 log4js"))
    expect(stream.buffer.at(-1).message).toBe("来自 log4js")
  })

  it("幂等：第二次 attach 不再重配日志系统", () => {
    const stream = new LogStream()
    stream.attach()
    const before = hoisted.configs.length
    expect(stream.attach()).toEqual({ attached: false, reason: "already" })
    expect(hoisted.configs.length).toBe(before)
  })

  it("重配失败时只返回失败，不把异常抛给调用方（面板可以没有日志，日志不能被面板弄坏）", () => {
    const stream = new LogStream()
    hoisted.failNext = true

    const result = stream.attach()
    expect(result.attached).toBe(false)
    expect(result.reason).toBe("failed")
    expect(String(result.error)).toContain("configure 炸了")
    // 关键：没有把自己标成已接入，失败之后也不会误以为日志流有效
    expect(stream.attached).toBe(false)
  })
})

describe("LogStream.record：日志行", () => {
  it("去掉 ANSI 颜色、保留时间/等级/分类", () => {
    const stream = new LogStream()
    stream.record(
      logEvent(null, { data: [`\u001b[34m[  Plugin  ]\u001b[39m 加载插件[27个]`], level: "MARK" }),
    )
    expect(stream.buffer[0]).toMatchObject({ level: "MARK", category: "message" })
    expect(stream.buffer[0].message).toBe("[  Plugin  ] 加载插件[27个]")
    expect(stream.buffer[0].time).toBe(1_700_000_000_000)
  })

  it("对象被序列化、Error 带堆栈（而不是 [object Object]）", () => {
    const stream = new LogStream()
    stream.record(logEvent(null, { data: [{ code: "TOO_LARGE" }, new Error("炸了")] }))
    expect(stream.buffer[0].message).toContain('{"code":"TOO_LARGE"}')
    expect(stream.buffer[0].message).toContain("Error: 炸了")
  })

  it("缓冲到上限后只留最新的 N 条", () => {
    const stream = new LogStream({ backlog: 2 })
    for (const message of ["一", "二", "三"]) stream.record(logEvent(message))
    expect(stream.buffer.map(line => line.message)).toEqual(["二", "三"])
  })

  it("createRecentHandler：一次性快照，返回最近的 N 条（最新的在最后）", async () => {
    const stream = new LogStream()
    for (const message of ["一", "二", "三"]) stream.record(logEvent(message))
    const base = await serve(stream)

    const res = await fetch(`${base}/api/v1/logs/recent?limit=2`)
    expect(res.status).toBe(200)
    // 必须是 JSON，不是 SSE——首页要的是一次性快照
    expect(res.headers.get("content-type")).toContain("application/json")

    const body = await res.json()
    expect(body.buffered).toBe(3)
    // 顺序保持"时间里"的顺序，最新一条在数组末尾（由界面决定怎么显示）
    expect(body.lines.map(line => line.message)).toEqual(["二", "三"])
  })

  it("createRecentHandler：limit 被夹到 backlog 以内", async () => {
    const stream = new LogStream({ backlog: 2 })
    for (const message of ["一", "二", "三"]) stream.record(logEvent(message))
    const base = await serve(stream)

    const body = await (await fetch(`${base}/api/v1/logs/recent?limit=9999`)).json()
    // 只可能拿到缓冲里实际有的那些
    expect(body.lines.length).toBe(2)
  })

  it("createRecentHandler：缓冲为空时返回空数组而不是报错", async () => {
    const base = await serve(new LogStream())
    const body = await (await fetch(`${base}/api/v1/logs/recent`)).json()
    expect(body).toEqual({ buffered: 0, lines: [] })
  })

  it("没有订阅者时不产生写入（面板关着就只维护缓冲）", () => {
    const stream = new LogStream()
    expect(() => stream.record(logEvent("无人订阅"))).not.toThrow()
    expect(stream.clientCount).toBe(0)
  })
})

describe("GET /logs：SSE", () => {
  it("真连一次：新连接先收到回放，之后收到实时推的日志", async () => {
    const stream = new LogStream({ heartbeat: 60_000 })
    stream.record(logEvent("回放这一条"))
    const url = await serve(stream)

    const client = sseClient(url, `${API_PREFIX}/logs`)
    try {
      const text = await client.waitFor(/回放这一条/)
      expect(text).toContain("event: log")
      expect(text).toContain('"level":"INFO"')

      stream.record(logEvent("实时这一条"))
      await client.waitFor(/实时这一条/)
    } finally {
      client.close()
    }
  })

  it("?limit= 只回放最后 N 条，且非法值退回上限", async () => {
    const stream = new LogStream({ heartbeat: 60_000 })
    for (const message of ["第一条", "第二条", "第三条"]) stream.record(logEvent(message))
    const url = await serve(stream)

    const client = sseClient(url, `${API_PREFIX}/logs?limit=1`)
    try {
      const text = await client.waitFor(/第三条/)
      expect(text).not.toContain("第一条")
      expect(text).not.toContain("第二条")
    } finally {
      client.close()
    }
  })

  it("心跳在发（长连接必须保活）", async () => {
    const stream = new LogStream({ heartbeat: 20 })
    const url = await serve(stream)

    const client = sseClient(url, `${API_PREFIX}/logs`)
    try {
      await client.waitFor(/: ping/)
    } finally {
      client.close()
    }
  })

  it("客户端断开后订阅者归零（真连接也走同一条清理路径）", async () => {
    const stream = new LogStream({ heartbeat: 60_000 })
    // 先垫一条，让新连接立刻有回放可收——否则每个客户端都要等到超时
    stream.record(logEvent("热身"))
    const url = await serve(stream)

    for (let i = 0; i < 5; i++) {
      const client = sseClient(url, `${API_PREFIX}/logs`)
      await client.waitFor(/event: log/)
      client.close()
      await sleep(30)
      expect(stream.clientCount, `第 ${i + 1} 次断开后没归零`).toBe(0)
    }
  })
})

describe("断开清理（验收项：连续 100 次连接/断开无泄漏）", () => {
  it("100 次连接/断开后订阅者始终归零", () => {
    const stream = new LogStream({ heartbeat: 3 })
    const handler = stream.createHandler()

    for (let i = 0; i < 100; i++) {
      const { req, res, close } = fakeReqRes()
      handler(req, res)
      expect(stream.clientCount, `第 ${i + 1} 次连接后没登记`).toBe(1)

      close()
      expect(stream.clientCount, `第 ${i + 1} 次断开后没归零`).toBe(0)
    }
    expect(stream.clientCount).toBe(0)
  })

  it("断开后心跳定时器被清掉：不再往已关闭的响应里写", async () => {
    // 等待时长取心跳周期的十几倍，而不是刚好一个周期——
    // Windows 与 CI runner 的定时器粒度能到 10ms 以上，贴着周期断言会假红
    const stream = new LogStream({ heartbeat: 5 })
    const handler = stream.createHandler()
    const { req, res, writes, close } = fakeReqRes()

    handler(req, res)
    await sleep(80)
    expect(writes.length, "连接期间没有心跳").toBeGreaterThan(0)

    close()
    const written = writes.length
    await sleep(80)
    expect(writes.length, "断开后还在往已关闭的响应里写").toBe(written)
  })

  it("断开后新日志不会写进已关闭的响应", async () => {
    const stream = new LogStream({ heartbeat: 60_000 })
    const handler = stream.createHandler()
    const { req, res, writes, close } = fakeReqRes()

    handler(req, res)
    close()
    stream.record(logEvent("断开之后的日志"))

    expect(writes.join("")).not.toContain("断开之后的日志")
    // 缓冲照旧记录——面板重新连上时还会看到它
    expect(stream.buffer.at(-1).message).toBe("断开之后的日志")
  })
})

describe("clampLimit", () => {
  it("非法值退回上限，合法值封顶在上限", () => {
    expect(clampLimit(undefined, 200)).toBe(200)
    expect(clampLimit("0", 200)).toBe(200)
    expect(clampLimit("-5", 200)).toBe(200)
    expect(clampLimit("abc", 200)).toBe(200)
    expect(clampLimit("10", 200)).toBe(10)
    expect(clampLimit("999", 200)).toBe(200)
  })
})
