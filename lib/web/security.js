/**
 * WebUI 的安全中间件。
 *
 * 对应 `docs/refactor/06-webui.md` §3.3，三个防护都参考 `astrbot/dashboard/server.py`：
 *
 * | 防护 | 为什么需要 |
 * |---|---|
 * | per-IP 令牌桶限流 | 面板上会有登录、重启、更新这类**不该被暴力尝试**的接口 |
 * | 请求体上限 | 全局 `express.json()` 的 100KB 默认值对"改一两个配置项"够用，但那是**默认值**，不是我们声明的上限 |
 * | 缺 `Content-Length` 的 multipart 一律 411 | 没有长度的 multipart 等于无界读取，而解析器会抢在任何校验之前开始收字节 |
 *
 * # 为什么自己写而不引依赖
 *
 * 这三件事各自只要几十行，而 `express-rate-limit` / `multer` 那类库会带来供应链与
 * 版本成本（`AGENTS.md` 规则 5：不新增依赖，除非直接解决当前问题且证据充分）。
 * 限流的定位是"保护少数敏感接口"，不是通用网关——所以没有分布式存储、没有
 * 白名单、没有 per-route 配置语言。
 */

/** 缺省参数。改这些数字等于改安全策略，请连带更新 `06-webui.md` §3.3。 */
export const DEFAULTS = {
  /** 令牌桶容量（允许的突发请求数） */
  burst: 60,
  /** 每秒回填的令牌数 */
  refillPerSec: 10,
  /** 单次请求体的缺省上限（1MB） */
  bodyLimit: 1024 * 1024,
  /** 桶表最多保留多少个键，超过时清理已回满的桶 */
  maxKeys: 4096,
}

/**
 * 限流键：客户端 IP。与 `serverAuth` 的 `req.rid` 同源，
 * 因此日志里的 `rid` 可以直接和限流记录对上。
 *
 * @param {import("express").Request} req 请求对象
 * @returns {string} 限流键
 */
export function ipOf(req) {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown"
}

/**
 * 统一的 JSON 响应。手动序列化而不是用 `res.json()`：
 * 后者的转义行为会随 express 版本变化，而这个接口是给第三方消费的契约。
 *
 * @param {import("express").Response} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {Record<string, unknown>} body 响应体
 * @returns {void} 无
 */
export function sendJSON(res, status, body) {
  res.status(status).type("json").send(JSON.stringify(body))
}

/**
 * 造一个 per-IP 令牌桶限流中间件。
 *
 * 语义：容量 `burst` 的桶按 `refillPerSec` 匀速回填；取不到令牌就 429，
 * 并给出 `Retry-After`（秒）。桶满之后的空闲桶与新建桶等价，因此可以安全清理。
 *
 * `now` 可注入：测试里不需要假定时器就能精确控制时间流逝。
 *
 * @param {object} [opts] 选项
 * @param {number} [opts.burst] 桶容量
 * @param {number} [opts.refillPerSec] 每秒回填量
 * @param {() => number} [opts.now] 取当前毫秒时间戳
 * @param {number} [opts.maxKeys] 桶表上限
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => void} 中间件
 */
export function createRateLimiter({
  burst = DEFAULTS.burst,
  refillPerSec = DEFAULTS.refillPerSec,
  now = Date.now,
  maxKeys = DEFAULTS.maxKeys,
} = {}) {
  /** @type {Map<string, { tokens: number, updatedAt: number }>} */
  const buckets = new Map()

  // 回满一个桶所需的毫秒数：等这么久之后，旧桶与新建的桶表现完全一致
  const fullAfterMs = (burst / refillPerSec) * 1000

  /** 清理已回满的桶 */
  const sweep = () => {
    const t = now()
    for (const [key, bucket] of buckets)
      if (t - bucket.updatedAt >= fullAfterMs) buckets.delete(key)
  }

  return (req, res, next) => {
    const key = ipOf(req)
    const t = now()
    let bucket = buckets.get(key)

    if (bucket) {
      bucket.tokens = Math.min(
        burst,
        bucket.tokens + ((t - bucket.updatedAt) / 1000) * refillPerSec,
      )
      bucket.updatedAt = t
    } else {
      bucket = { tokens: burst, updatedAt: t }
      buckets.set(key, bucket)
      // 键的数量只受客户端 IP 数量影响；一次请求最多触发一次清理
      if (buckets.size > maxKeys) sweep()
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return next()
    }

    const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec))
    res.set("Retry-After", String(retryAfter))
    return sendJSON(res, 429, {
      code: "rate_limited",
      message: `请求过于频繁，请 ${retryAfter} 秒后重试`,
    })
  }
}

/**
 * 造一个请求体上限中间件。
 *
 * 只看 `Content-Length`，**不读 body**：超限就 413，连一字节都不收。
 *
 * ⚠️ 它挂在全局 body 解析器**之后**，两者分工是：
 * 解析器兜住绝对上限（超过 100KB 的 JSON 会抛 `PayloadTooLargeError`，
 * 由 API 的错误处理映射成 413），本中间件负责把 API 路径压到我们声明的上限。
 * 因此**不能**把它当作"唯一的体积防线"。
 *
 * @param {object} [opts] 选项
 * @param {number} [opts.limit] 字节上限
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => void} 中间件
 */
export function createBodyLimit({ limit = DEFAULTS.bodyLimit } = {}) {
  return (req, res, next) => {
    const raw = req.headers["content-length"]
    const type = String(req.headers["content-type"] ?? "")

    if (raw === undefined) {
      // 没有长度就没有上界。multipart 一律拒绝：解析器一旦开始读就没有"中途止损"的位置了。
      if (type.startsWith("multipart/form-data"))
        return sendJSON(res, 411, {
          code: "length_required",
          message: "multipart 请求必须带 Content-Length",
        })
      return next()
    }

    const length = Number(raw)
    if (!Number.isFinite(length) || length < 0)
      return sendJSON(res, 400, { code: "bad_request", message: "Content-Length 不合法" })

    if (length > limit)
      return sendJSON(res, 413, {
        code: "payload_too_large",
        message: `请求体过大：上限 ${limit} 字节，实际 ${length} 字节`,
      })

    next()
  }
}
