import cfg from "../config/config.js"
import LogStream from "./api/logs.js"
import { createApiRouter } from "./api/router.js"
import { createBodyLimit, createRateLimiter, sendJSON } from "./security.js"

/**
 * WebUI 的挂载前缀。
 *
 * 统一加前缀是刻意的：`/status`、`/exit`、`/File` 是既有的对外契约，
 * 各适配器也会自行注册路径（`Bot.express` / `Bot.wsf`），
 * 新路径不占根路径就不会与它们冲突。
 */
export const UI_PREFIX = "/dashboard"
export const API_PREFIX = "/api/v1"

/**
 * 取宿主的在线状态（`0` 未启动 / `1` 启动中 / `2` 已上线）。
 *
 * 走全局 `Bot` 而不是 import `lib/bot.js`：那个模块在构造时就会建立 express 应用，
 * 而本模块要在**它之前**接入中间件链，互相 import 会绕成环。
 *
 * @returns {number|undefined} 状态值
 */
function defaultOnline() {
  return /** @type {{ stat?: { online?: number } }} */ (globalThis.Bot)?.stat?.online
}

/**
 * WebUI 的挂载门卫与就绪语义。
 *
 * 对应 `docs/refactor/06-webui.md` §3.1 / §3.3。四个设计要点：
 *
 * 1. **复用宿主的 express 应用**，不另起进程与端口（否则会有两套鉴权、两个端口）；
 * 2. **默认关闭**：`server.webui.enable` 不为 `true` 时每个入口都是纯透传，
 *    行为与改造前逐字一致（连日志都不打）；
 * 3. **启用但 `server.auth` 为空时拒绝挂载**，并在日志里给出可照抄的配置；
 * 4. 启动期的请求**就地答复**而不是等 online——见 `earlyProbe` 的说明。
 */
export class WebUI {
  /**
   * @param {object} [opts] 选项
   * @param {object} [opts.cfg] 宿主配置（默认取模块单例）
   * @param {() => number|undefined} [opts.onlineOf] 取宿主在线状态
   * @param {() => object|undefined} [opts.hostOf] 取宿主对象（用于打日志）
   */
  constructor({ cfg: config = cfg, onlineOf = defaultOnline, hostOf = () => globalThis.Bot } = {}) {
    this.cfg = config
    this.onlineOf = onlineOf
    this.hostOf = hostOf
    /** 是否已挂载（`mount()` 幂等） */
    this.mounted = false
  }

  /**
   * 配置上是否启用了 WebUI。
   *
   * ⚠️ 是 `cfg.server.webui.enable` 而不是 `cfg.webui.enable`：`cfg.<名字>` 映射的是
   * `config/config/<名字>.yaml` 这个**文件**（见 `lib/config/config.js` 的 Proxy 说明），
   * 写 `cfg.webui` 会去找一个不存在的 `webui.yaml`，于是永远读到 `undefined`——
   * 那是一个**静默**的失败：面板永不启用，而没有任何报错。
   */
  get enabled() {
    return this.cfg?.server?.webui?.enable === true
  }

  /** 是否配置了鉴权令牌（`server.auth` 非空） */
  get hasAuth() {
    const auth = this.cfg?.server?.auth
    return !!auth && Object.keys(auth).length > 0
  }

  /**
   * 打一条日志。宿主还没就绪时退回 console——配置错误必须让人看见，
   * 不能因为"logger 还没装好"而静默。
   *
   * @param {string} level 日志等级
   * @param {unknown} content 内容
   * @returns {void} 无
   */
  log(level, content) {
    const bot = this.hostOf()
    if (typeof bot?.makeLog === "function") return void bot.makeLog(level, content, "WebUI")
    const write = level === "error" || level === "warn" ? console.error : console.log
    write("[WebUI]", content)
  }

  /**
   * 启动期的早期探针。**必须挂在 `serverAuth` 之前。**
   *
   * 理由：`serverAuth` 是中间件链的第一个，`stat.online !== 2` 时它会把请求
   * **挂起**等待 `online` 事件，而不是返回错误。于是启动期到达的任何请求
   * （包括"就绪探针"自己）都到不了终点，前端只能表现为一直转圈。
   * 所以只有挂在它之前，才能对 WebUI 的两个前缀给出明确答复。
   *
   * 未启用 WebUI 时是纯透传，不影响任何既有路径。
   *
   * @param {import("express").Request} req 请求对象
   * @param {import("express").Response} res 响应对象
   * @param {import("express").NextFunction} next 下一个中间件
   * @returns {void} 无
   */
  earlyProbe(req, res, next) {
    if (!this.enabled) return next()

    const url = req.originalUrl || req.url || "/"
    if (!url.startsWith(UI_PREFIX) && !url.startsWith(API_PREFIX)) return next()
    if (this.onlineOf() === 2) return next()

    res.set("Retry-After", "2")
    if (url.startsWith(API_PREFIX))
      return sendJSON(res, 503, {
        code: "starting",
        message: "宿主尚未就绪（等待适配器上线），请稍后重试",
      })

    // 面板本身：给一个能看懂的中文提示，而不是空白页
    res
      .status(503)
      .type("html")
      .send(
        [
          "<!doctype html><meta charset=utf-8>",
          "<title>正在启动</title>",
          "<h1>正在启动</h1>",
          "<p>宿主还没有完成启动（等待适配器上线）。这个页面会自动重试。</p>",
          "<script>setTimeout(function () { location.reload() }, 2000)</script>",
        ].join("\n"),
      )
  }

  /**
   * 把 API 挂到宿主的 express 应用上。
   *
   * 幂等；未启用或未配置鉴权时**不挂载**并返回原因，由调用方决定是否视为致命错误。
   *
   * @param {import("express").Express} app 宿主的 express 应用
   * @param {{ loader?: object }} [deps] 依赖
   * @returns {{ mounted: boolean, reason: "disabled"|"no-auth"|"mounted"|"already" }} 结果
   */
  mount(app, { loader } = {}) {
    if (this.mounted) return { mounted: true, reason: "already" }
    if (!this.enabled) return { mounted: false, reason: "disabled" }

    if (!this.hasAuth) {
      this.log("error", [
        "WebUI 已启用（server.webui.enable: true），但 server.auth 为空 —— 已拒绝挂载 /dashboard 与 /api/v1。",
        "空 auth 时 serverAuth 会完全放行，把面板暴露出去等于把宿主交给任何能访问这个端口的人。",
        "请在 config/config/server.yaml 里配置（键名 = 请求头名，值 = 该头应携带的令牌）：",
        "  auth:",
        "    Authorization: Bearer <自己生成的长随机串>",
      ])
      return { mounted: false, reason: "no-auth" }
    }

    // 给 log4js 追加广播 appender（幂等）。失败只记一笔：面板看不到日志可以接受，
    // "日志系统被面板弄坏"不可以——那时旧的配置仍然生效。
    const attached = LogStream.attach()
    if (attached.reason === "failed")
      this.log("error", ["日志流接入失败，面板将看不到日志：", attached.error])

    // 路由集中在 api/router.js（那里是唯一登记路径的地方，与 openapi.yaml 一一对应）
    const router = createApiRouter({
      onlineOf: this.onlineOf,
      hostOf: this.hostOf,
      loader,
      logStream: LogStream,
      version: this.cfg?.package?.version ?? "unknown",
    })
    // 顺序：先限流（便宜），再查长度（不读 body），最后才进路由
    app.use(API_PREFIX, createRateLimiter(), createBodyLimit(), router)
    // 错误处理单独占一层，**不放进 Router 内部**：解析器挂在路由之前（全局），
    // 它抛出的错误走到这一层时，Router 内部的 4 参处理器接不到（express 只会找
    // 声明了 4 个形参的层，挂在应用层才看得见）。
    app.use(API_PREFIX, apiErrorHandler)
    this.mounted = true
    this.log(
      "mark",
      `WebUI 已挂载：${API_PREFIX}（鉴权头：${Object.keys(this.cfg.server.auth).join(" / ")}）`,
    )

    // 监听地址没显式配置时，Node 会绑到全部网卡上——而面板是给人用的，
    // 多数部署并不需要它出现在局域网里。只提示，不改行为（改默认值会静默影响
    // `/File` 的对外图片地址与适配器的回调地址）。
    if (!this.cfg?.server?.address)
      this.log("warn", [
        "server.address 未配置，HTTP 服务监听在 Node 的默认网卡上（全部地址）。",
        "若不需要从外部访问面板，请在 config/config/server.yaml 里设置 address: 127.0.0.1",
      ])

    return { mounted: true, reason: "mounted" }
  }
}

/**
 * `/api/v1` 的错误处理：把 body 解析器的错误映射成 JSON。
 *
 * 为什么需要：全局的 `express.json()` 在链上比 API 更早，它抛出的
 * `PayloadTooLargeError` 会一路传到宿主的 `serverError`——那里的处理是
 * `res.end()`，即**一个 200 空响应**。对 API 客户端来说这是最难排查的一种失败。
 *
 * @param {any} err 错误
 * @param {import("express").Request} req 请求对象
 * @param {import("express").Response} res 响应对象
 * @param {import("express").NextFunction} next 下一个错误处理
 * @returns {void} 无
 */
function apiErrorHandler(err, req, res, next) {
  if (err?.type === "entity.too.large")
    return sendJSON(res, 413, { code: "payload_too_large", message: "请求体过大" })
  if (err?.type === "entity.parse.failed")
    return sendJSON(res, 400, { code: "bad_request", message: "请求体不是合法的 JSON" })
  if (typeof err?.status === "number" && err.status < 500)
    return sendJSON(res, err.status, { code: "bad_request", message: String(err.message ?? err) })
  // 其余交给宿主（它只记日志并结束响应）
  next(err)
}

/** 全局单例。`lib/bot.js` 直接引用它，避免每处各建一份挂载状态。 */
export default new WebUI()
