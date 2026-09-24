import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createControlCapabilitiesHandler,
  createLocalOnlyGate,
  createRestartHandler,
  createStopHandler,
  isLocalAddress,
} from "../../../lib/web/api/control.js"

/**
 * 进程控制的测试（v3）。
 *
 * 这一块比配置写入更危险：**它能把服务停掉**，而停止不会自己回来。
 * 所以测试的重点不是"功能对不对"，而是"该拒的有没有拒住"——
 * 尤其是"公网来源不许调用"这条，它是唯一挡住"给公网一个关机按钮"的东西。
 */

/** 造一个可链式调用的最小响应对象 */
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
  return res
}

/** 造一个"来源地址是 addr"的请求替身 */
function reqFrom(addr, headers = {}) {
  return { socket: { remoteAddress: addr }, headers, url: "/api/v1/control/restart" }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("isLocalAddress", () => {
  it("放行本机与内网地址", () => {
    for (const addr of [
      "::1",
      "127.0.0.1",
      "::ffff:127.0.0.1",
      "10.0.0.5",
      "192.168.68.26",
      "::ffff:192.168.1.10",
      "172.16.0.1",
      "172.31.255.254",
    ])
      expect(isLocalAddress(reqFrom(addr)), `${addr} 应当放行`).toBe(true)
  })

  it("拒绝公网地址", () => {
    for (const addr of ["8.8.8.8", "1.2.3.4", "172.32.0.1", "172.15.0.1", "203.0.113.9", ""])
      expect(isLocalAddress(reqFrom(addr)), `${addr} 应当拒绝`).toBe(false)
  })

  it("**不看 X-Forwarded-For**：那个头是客户端可伪造的", () => {
    // 这条是这一整套防护的关键：如果信了这个头，攻击者只要加一行
    // `X-Forwarded-For: 127.0.0.1` 就拿到了关机按钮
    expect(isLocalAddress(reqFrom("8.8.8.8", { "x-forwarded-for": "127.0.0.1" }))).toBe(false)
    expect(isLocalAddress(reqFrom("8.8.8.8", { "x-real-ip": "192.168.1.1" }))).toBe(false)
  })
})

describe("createLocalOnlyGate", () => {
  it("放行内网来源", () => {
    const gate = createLocalOnlyGate()
    let passed = false
    gate(reqFrom("127.0.0.1"), resOf(), () => (passed = true))
    expect(passed).toBe(true)
  })

  it("拒绝公网来源，并返回 403（不是 401）", () => {
    const gate = createLocalOnlyGate()
    const res = resOf()
    gate(reqFrom("8.8.8.8"), res, () => {
      throw new Error("不该放行")
    })

    // 403 而不是 401：401 会让人以为"令牌填错了"从而反复试令牌，
    // 而真正的原因是"你这个来源不允许做这件事"
    expect(res.statusCode).toBe(403)
    const body = JSON.parse(String(res.body))
    expect(body.code).toBe("forbidden")
    expect(body.message).toContain("VPN")
    expect(body.message).toContain("8.8.8.8")
  })
})

describe("createControlCapabilitiesHandler", () => {
  it("内网来源 canControl=true", () => {
    const res = resOf()
    createControlCapabilitiesHandler()(reqFrom("192.168.1.5"), res)
    const body = JSON.parse(String(res.body))
    expect(body.canControl).toBe(true)
    // 停止不会自动恢复——界面据此加二次确认
    expect(body.stopIsRecoverable).toBe(false)
  })

  it("公网来源 canControl=false（界面据此把按钮置灰）", () => {
    const res = resOf()
    createControlCapabilitiesHandler()(reqFrom("8.8.8.8"), res)
    expect(JSON.parse(String(res.body)).canControl).toBe(false)
  })
})

describe("重启 / 停止处理器", () => {
  it("重启返回 202 已受理，且**不会**在响应前就动进程", () => {
    vi.useFakeTimers()
    const spawnOf = vi.fn(() => ({ unref: vi.fn() }))
    const res = resOf()

    createRestartHandler({ hostOf: () => ({}), spawnOf, delay: 500 })(reqFrom("127.0.0.1"), res)

    // 关键：响应必须先发出去。进程一重启连接就断了，
    // 先动手的话前端只会拿到一个网络错误、永远看不到"已受理"
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(String(res.body))).toMatchObject({ code: "accepted", action: "restart" })
    // 还没到延迟，不该已经拉起新进程
    expect(spawnOf).not.toHaveBeenCalled()

    vi.useRealTimers()
  })

  it("停止返回 202，并说明不会自动恢复", () => {
    const res = resOf()
    createStopHandler({ hostOf: () => ({}), delay: 60_000 })(reqFrom("127.0.0.1"), res)

    expect(res.statusCode).toBe(202)
    const body = JSON.parse(String(res.body))
    expect(body.action).toBe("stop")
    // 这句是给用户看的最后一句话：点完这个按钮，服务就没了
    expect(body.message).toContain("不会自动恢复")
  })
})
