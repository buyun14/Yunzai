import { describe, expect, it } from "vitest"
import { createBodyLimit, createRateLimiter, ipOf, sendJSON } from "../../../lib/web/security.js"

/**
 * 安全中间件的单测。
 *
 * 这里直接调用中间件并断言响应对象，而不是起 HTTP 服务：限流需要精确控制
 * "时间过了多久"，用真实网络做这件事会变成又慢又脆的测试。
 * "中间件真的挂进了应用链"由 `server.test.js` 用真实请求证明。
 */

/**
 * 造一个最小请求对象。
 *
 * @param {{ ip?: string, headers?: Record<string, string> }} [opts] 覆盖项
 * @returns {Record<string, unknown>} 请求替身
 */
function reqOf({ ip = "1.2.3.4", headers = {} } = {}) {
  return { ip, headers, socket: { remoteAddress: ip }, originalUrl: "/api/v1/ready" }
}

/**
 * 造一个可链式调用的最小响应对象（`sendJSON` 用了 status/type/send 三个方法）。
 *
 * @returns {Record<string, unknown>} 响应替身
 */
function resOf() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      res.headers[name] = value
      return res
    },
    status(code) {
      res.statusCode = code
      return res
    },
    type(value) {
      res.headers["content-type"] = value
      return res
    },
    send(body) {
      res.body = body
      return res
    },
  }
  res.headers = {}
  return res
}

/**
 * 跑一次中间件，返回 `{ res, passed }`。
 *
 * @param {Function} middleware 中间件
 * @param {Record<string, unknown>} req 请求替身
 * @returns {{ res: Record<string, unknown>, passed: boolean }} 结果
 */
function run(middleware, req) {
  const res = resOf()
  let passed = false
  middleware(req, res, () => (passed = true))
  return { res, passed }
}

describe("ipOf：限流键", () => {
  it("优先取 req.ip（与 serverAuth 的 req.rid 同源）", () => {
    expect(ipOf(reqOf({ ip: "10.0.0.1" }))).toBe("10.0.0.1")
  })

  it("req.ip 缺失时退回 socket.remoteAddress", () => {
    expect(ipOf({ socket: { remoteAddress: "::1" } })).toBe("::1")
  })

  it("都没有时给一个固定键，而不是 undefined（否则所有异常请求会共用一个 Map 键）", () => {
    expect(ipOf({ headers: {} })).toBe("unknown")
  })
})

describe("createRateLimiter：令牌桶", () => {
  it("桶内有令牌时放行", () => {
    const limiter = createRateLimiter({ burst: 2, refillPerSec: 1 })
    expect(run(limiter, reqOf()).passed).toBe(true)
  })

  it("令牌耗尽后返回 429，并给出 Retry-After", () => {
    const limiter = createRateLimiter({ burst: 2, refillPerSec: 1 })
    run(limiter, reqOf())
    run(limiter, reqOf())

    const { res, passed } = run(limiter, reqOf())
    expect(passed).toBe(false)
    expect(res.statusCode).toBe(429)
    expect(res.headers["Retry-After"]).toBe("1")
    expect(JSON.parse(String(res.body))).toMatchObject({ code: "rate_limited" })
  })

  it("按时间匀速回填：等够一个令牌的时间后重新放行", () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ burst: 1, refillPerSec: 1, now: () => now })
    expect(run(limiter, reqOf()).passed).toBe(true)
    expect(run(limiter, reqOf()).passed).toBe(false)

    now += 1000
    expect(run(limiter, reqOf()).passed).toBe(true)
  })

  it("回填不会超过桶容量（长期空闲不会攒出无限令牌）", () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ burst: 2, refillPerSec: 100, now: () => now })
    now += 1_000_000
    expect(run(limiter, reqOf()).passed).toBe(true)
    expect(run(limiter, reqOf()).passed).toBe(true)
    expect(run(limiter, reqOf()).passed).toBe(false)
  })

  it("每个 IP 一个独立的桶（一个客户端刷不动另一个）", () => {
    const limiter = createRateLimiter({ burst: 1, refillPerSec: 1 })
    expect(run(limiter, reqOf({ ip: "1.1.1.1" })).passed).toBe(true)
    expect(run(limiter, reqOf({ ip: "1.1.1.1" })).passed).toBe(false)
    expect(run(limiter, reqOf({ ip: "2.2.2.2" })).passed).toBe(true)
  })

  it("桶表超上限时清理已回满的桶（避免 IP 数量把内存撑爆）", () => {
    let now = 1_000_000
    const limiter = createRateLimiter({ burst: 1, refillPerSec: 1, maxKeys: 2, now: () => now })

    run(limiter, reqOf({ ip: "a" }))
    run(limiter, reqOf({ ip: "b" }))
    now += 5000 // 两个桶都已回满：它们与新建的桶等价
    run(limiter, reqOf({ ip: "c" })) // 触发清理

    // a 的桶被清掉后重新创建，因此仍有令牌——清理不改变语义
    expect(run(limiter, reqOf({ ip: "a" })).passed).toBe(true)
    // 而刚用过令牌的 c 仍然被拦
    expect(run(limiter, reqOf({ ip: "c" })).passed).toBe(false)
  })
})

describe("createBodyLimit：请求体上限", () => {
  it("未超限时放行", () => {
    const limit = createBodyLimit({ limit: 100 })
    expect(run(limit, reqOf({ headers: { "content-length": "100" } })).passed).toBe(true)
  })

  it("超过上限返回 413，且带上上限与实际值", () => {
    const limit = createBodyLimit({ limit: 100 })
    const { res, passed } = run(limit, reqOf({ headers: { "content-length": "101" } }))
    expect(passed).toBe(false)
    expect(res.statusCode).toBe(413)
    expect(JSON.parse(String(res.body)).message).toContain("101")
  })

  it("没有 Content-Length 的 multipart 返回 411（无界读取）", () => {
    const limit = createBodyLimit({ limit: 100 })
    const { res } = run(
      limit,
      reqOf({ headers: { "content-type": "multipart/form-data; boundary=x" } }),
    )
    expect(res.statusCode).toBe(411)
  })

  it("非 multipart 且无 Content-Length 时放行——交给 body 解析器处理", () => {
    const limit = createBodyLimit({ limit: 100 })
    expect(run(limit, reqOf({ headers: { "content-type": "application/json" } })).passed).toBe(true)
  })

  it("Content-Length 不是合法数字时返回 400，而不是当成 0", () => {
    const limit = createBodyLimit({ limit: 100 })
    const { res } = run(limit, reqOf({ headers: { "content-length": "abc" } }))
    expect(res.statusCode).toBe(400)
  })
})

describe("sendJSON", () => {
  it("设置状态码与 application/json", () => {
    const res = resOf()
    sendJSON(res, 418, { code: "teapot" })
    expect(res.statusCode).toBe(418)
    expect(res.headers["content-type"]).toBe("json")
    expect(res.body).toBe('{"code":"teapot"}')
  })
})
