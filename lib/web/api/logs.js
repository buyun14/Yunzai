import log4js from "log4js"
import { buildLogConfig } from "../../config/log.js"

/**
 * `GET /api/v1/logs`：SSE 实时日志流。
 *
 * 对应 `docs/refactor/06-webui.md` §3.5（实时通道选 SSE 的理由：单向、自动重连、
 * 不需要额外握手）。
 *
 * # 为什么用 log4js appender，而不是 tail 落盘文件
 *
 * 落盘文件是现成的（`plugins/other/sendLog.js` 的 `#日志` 就读它），但 `appenders.command`
 * 只收 `warn` 与 `mark`——**`info` / `debug` 根本不落盘**（它们只进 stdout）。
 * 面板上缺的恰恰是"插件加载了哪些""这条消息走了哪条路"这类 info。
 * 所以这里给 log4js 追加一个 appender，拿的是与终端**同一份**日志事件。
 *
 * # 代价与约束
 *
 * - 需要 `log4js.configure()` 再跑一次（配置对象由 `lib/config/log.js` 的
 *   `buildLogConfig()` 提供，不是复制一份）。只在面板启用时才做，且失败**不抛**：
 *   面板看不到日志可以接受，"日志系统被面板弄坏"不可以。
 * - 三个分类都要挂：一次日志调用只进一个分类，所以不会重复。
 * - 响应头必须带 `no-transform`：宿主链上有 `compression()`，而它会把小于阈值的分片
 *   攒在缓冲区里——SSE 全是小分片，不声明就表现为"连上了但一条都看不到"。
 */

/** 回放缓冲的默认长度：新连接先拿到最近这么多条，避免面对空屏 */
export const BACKLOG = 200

/** 心跳间隔（毫秒）。长连接在中间有代理时会被掐断，定时发注释行保活 */
export const HEARTBEAT = 15000

/** ANSI 转义序列（chalk 上色）。浏览器里显示不出来，只会看到一坨 `[32m` */
// eslint-disable-next-line no-control-regex -- 要匹配的就是控制字符本身，不是笔误
const ANSI = /\u001b\[[0-9;]*m/g

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // nginx 默认会缓冲响应；这一行是让面板在反代后面也能实时刷新的标准做法
  "X-Accel-Buffering": "no",
}

/** 日志流与订阅者。导出类是为了让测试能各造一份互不干扰的实例 */
export class LogStream {
  /**
   * @param {object} [opts] 选项
   * @param {number} [opts.backlog] 回放缓冲长度
   * @param {number} [opts.heartbeat] 心跳间隔（毫秒）
   */
  constructor({ backlog = BACKLOG, heartbeat = HEARTBEAT } = {}) {
    this.backlog = backlog
    this.heartbeat = heartbeat
    /** @type {Set<(payload: string) => void>} */
    this.clients = new Set()
    /** @type {Array<Record<string, unknown>>} */
    this.buffer = []
    this.attached = false
  }

  /** 当前订阅者数量（测试与诊断用；断开后必须回到 0） */
  get clientCount() {
    return this.clients.size
  }

  /**
   * 给 log4js 追加广播 appender。**幂等**。
   *
   * @returns {{ attached: boolean, reason?: "already"|"failed", error?: unknown }} 结果
   */
  attach() {
    if (this.attached) return { attached: false, reason: "already" }

    const config = buildLogConfig()
    // log4js 6 的约定：`type.configure(config, layouts)` 返回真正的 appender 函数。
    // 直接给函数是不行的——它会把 `type` 当模块名去 require。
    config.appenders.webui = { type: { configure: () => event => this.record(event) } }
    for (const category of Object.values(config.categories)) category.appenders.push("webui")

    try {
      log4js.configure(config)
    } catch (err) {
      return { attached: false, reason: "failed", error: err }
    }

    this.attached = true
    return { attached: true }
  }

  /**
   * 记一条日志：进回放缓冲，并推给所有订阅者。
   *
   * @param {Record<string, any>} event log4js 的日志事件
   * @returns {void} 无
   */
  record(event) {
    const line = {
      time: event.startTime instanceof Date ? event.startTime.getTime() : Date.now(),
      level: event.level?.levelStr ?? "INFO",
      category: event.categoryName ?? "default",
      message: (Array.isArray(event.data) ? event.data : [event.data])
        .map(toText)
        .join(" ")
        .replace(ANSI, ""),
    }

    this.buffer.push(line)
    if (this.buffer.length > this.backlog) this.buffer.splice(0, this.buffer.length - this.backlog)
    if (!this.clients.size) return

    const payload = serialize(line)
    for (const send of this.clients) send(payload)
  }

  /**
   * 最近 N 条日志的**一次性快照**（JSON）。
   *
   * 与 SSE 那条路分开是刻意的，不是偷懒：
   *
   * - SSE 是**长连接**，一个页面开着就一直占着一个订阅者。首页只想显示
   *   "最近发生了什么"、并不需要逐条推送——为它开一条长连接是浪费，
   *   而且用户切走页面时的清理比轮询更容易出错。
   * - 轮询的代价可控（首页 10 秒一次、只要 20 条），而收益是首页的失败模式
   *   退化成"这块内容不更新"，不会像 SSE 那样留下半死不活的连接。
   *
   * @param {object} [opts] 选项
   * @param {number} [opts.max] 单次最多返回多少条
   * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
   */
  createRecentHandler({ max = 100 } = {}) {
    return (req, res) => {
      const limit = clampLimit(req.query.limit, Math.min(max, this.backlog))
      res.status(200).json({
        // 只有**服务器**真正记下来的那些；`buffer` 的长度受 backlog 限制
        buffered: this.buffer.length,
        lines: this.buffer.slice(-limit),
      })
    }
  }

  /**
   * SSE 处理器。
   *
   * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
   */
  createHandler() {
    return (req, res) => {
      res.status(200).set(SSE_HEADERS)
      // 立刻把响应头推出去，否则客户端要等到第一条数据才知道连接成功
      res.flushHeaders?.()

      for (const line of this.buffer.slice(-clampLimit(req.query.limit, this.backlog)))
        res.write(serialize(line))

      const send = payload => res.write(payload)
      const timer = setInterval(() => res.write(": ping\n\n"), this.heartbeat)
      // 心跳只是保活，不应该拖着进程不退出
      timer.unref?.()

      this.clients.add(send)

      let cleaned = false
      const cleanup = () => {
        // req 与 res 的 close 都会走到这里；重复调用必须无副作用
        if (cleaned) return
        cleaned = true
        clearInterval(timer)
        this.clients.delete(send)
      }
      req.on("close", cleanup)
      res.on("close", cleanup)
    }
  }
}

/**
 * `?limit=` 的取值：小于等于 0、非数字或超上限时退回上限。
 *
 * @param {unknown} value 请求给的原始值
 * @param {number} max 上限
 * @returns {number} 条数
 */
export function clampLimit(value, max) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return max
  return Math.min(Math.floor(limit), max)
}

/**
 * 一条日志事件的 SSE 帧。
 *
 * @param {Record<string, unknown>} line 日志行
 * @returns {string} 帧文本
 */
function serialize(line) {
  return `event: log\ndata: ${JSON.stringify(line)}\n\n`
}

/**
 * 日志事件里的一个值 → 文本。
 *
 * 对象要显式序列化：log4js 直接把 `data` 原样传过来，而 `String(obj)` 会得到
 * `[object Object]`——那等于把信息丢了。循环引用时退回 `String()` 而不是抛错，
 * 因为"日志打不出来"比"少一个字段"严重。
 *
 * @param {unknown} value 值
 * @returns {string} 文本
 */
function toText(value) {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack ?? String(value)
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** 全局单例。`lib/web/server.js` 用它接入 appender 并登记路由。 */
export default new LogStream()
