import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
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

/** 前端构建产物目录（`dashboard/` 是独立的 workspace 包，产物不进仓库） */
export const UI_DIST = fileURLToPath(new URL("../../dashboard/dist", import.meta.url))

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
   * 取前端静态资源的中间件（供 `lib/bot.js` 挂在 `serverAuth` **之前**）。
   *
   * 单独暴露而不是只在 `mount()` 里挂，是因为**中间件顺序是这里的核心约束**：
   * 浏览器的第一个请求是 HTML 文档、且 `<script>` 带不了自定义头，
   * 所以这层必须排在宿主的鉴权之前（理由与安全边界见 `mountFrontend`）。
   * 调用方负责把它挂对位置——`lib/bot.js` 的 `express` 链就是权威顺序。
   *
   * 取不到产物时返回的中间件是纯 `next()`，因此调用方不必判断
   * "前端有没有构建"。
   *
   * @param {{ distDir?: string, skipAuth?: string[] }} [opts] 选项
   * @returns {import("express").RequestHandler} 中间件
   */
  frontend({ distDir = UI_DIST, skipAuth } = {}) {
    if (!this.enabled) return (req, res, next) => next()

    // 资源前缀要进 `skip_auth`：`<script>` / `<link>` 带不了自定义请求头，
    // 不放行就是「HTML 出来了、脚本全 401」，表现得像打包坏了。
    if (Array.isArray(skipAuth) && !skipAuth.includes(`${UI_PREFIX}/assets`)) {
      // ⚠️ 只放行 assets，**不放行整个 `/dashboard`**：`skip_auth` 是前缀匹配
      // （`serverAuth` 用 `originalUrl.startsWith`），放行 `/dashboard` 会连
      // 适配器挂在它下面的路径一起免鉴权。入口文档由本中间件自己认形状放行。
      skipAuth.push(`${UI_PREFIX}/assets`)
    }

    const { mode, middleware } = mountFrontend(distDir, { log: this.log.bind(this) })
    this.frontendMode = mode
    return middleware
  }

  /**
   * 把前端产物与 API 挂到宿主的 express 应用上。
   *
   * 幂等；未启用或未配置鉴权时**不挂载**并返回原因，由调用方决定是否视为致命错误。
   *
   * @param {import("express").Express} app 宿主的 express 应用
   * @param {{ loader?: object, distDir?: string }} [deps] 依赖
   * @returns {{ mounted: boolean, reason: "disabled"|"no-auth"|"mounted"|"already", frontend: "dist"|"missing" }} 结果
   */
  mount(app, { loader, distDir = UI_DIST } = {}) {
    if (this.mounted) return { mounted: true, reason: "already", frontend: "dist" }
    if (!this.enabled) return { mounted: false, reason: "disabled", frontend: "missing" }

    if (!this.hasAuth) {
      this.log("error", [
        "WebUI 已启用（server.webui.enable: true），但 server.auth 为空 —— 已拒绝挂载 /dashboard 与 /api/v1。",
        "空 auth 时 serverAuth 会完全放行，把面板暴露出去等于把宿主交给任何能访问这个端口的人。",
        "请在 config/config/server.yaml 里配置（键名 = 请求头名，值 = 该头应携带的令牌）：",
        "  auth:",
        "    Authorization: Bearer <自己生成的长随机串>",
      ])
      return { mounted: false, reason: "no-auth", frontend: "missing" }
    }

    // 给 log4js 追加广播 appender（幂等）。失败只记一笔：面板看不到日志可以接受，
    // "日志系统被面板弄坏"不可以——那时旧的配置仍然生效。
    const attached = LogStream.attach()
    if (attached.reason === "failed")
      this.log("error", ["日志流接入失败，面板将看不到日志：", attached.error])

    const frontend = mountFrontend(distDir, { log: this.log.bind(this) }).mode
    this.frontendMode = frontend

    app.use(API_PREFIX, createRateLimiter(), createBodyLimit())

    // 路由集中在 api/router.js（那里是唯一登记路径的地方，与 openapi.yaml 一一对应）
    const router = createApiRouter({
      onlineOf: this.onlineOf,
      hostOf: this.hostOf,
      loader,
      logStream: LogStream,
      version: this.cfg?.package?.version ?? "unknown",
    })
    app.use(API_PREFIX, router)
    // 错误处理单独占一层，**不放进 Router 内部**：解析器挂在路由之前（全局），
    // 它抛出的错误走到这一层时，Router 内部的 4 参处理器接不到（express 只会找
    // 声明了 4 个形参的层，挂在应用层才看得见）。
    app.use(API_PREFIX, apiErrorHandler)
    this.mounted = true
    this.log(
      "mark",
      `WebUI 已挂载：${UI_PREFIX} 与 ${API_PREFIX}（鉴权头：${Object.keys(this.cfg.server.auth).join(" / ")}）`,
    )

    // 监听地址没显式配置时，Node 会绑到全部网卡上——而面板是给人用的，
    // 多数部署并不需要它出现在局域网里。只提示，不改行为（改默认值会静默影响
    // `/File` 的对外图片地址与适配器的回调地址）。
    if (!this.cfg?.server?.address)
      this.log("warn", [
        "server.address 未配置，HTTP 服务监听在 Node 的默认网卡上（全部地址）。",
        "若不需要从外部访问面板，请在 config/config/server.yaml 里设置 address: 127.0.0.1",
      ])

    return { mounted: true, reason: "mounted", frontend }
  }
}

/**
 * 造前端中间件（静态资源 + 入口文档）。**必须挂在宿主的 `serverAuth` 之前。**
 *
 * # 为什么必须排在 `serverAuth` 之前（真机跳出来的坑）
 *
 * 浏览器打开面板时，**第一个请求是 HTML 文档本身**，而 `<script>` / `<link>`
 * 加载资源时也**没法带自定义请求头**。宿主的鉴权是「静态头比对」，
 * 所以「文档」和「资源」两类请求都必然拿不到令牌：
 *
 * - 只把 `/dashboard/assets` 放进 `skip_auth` 时，真机表现是
 *   **`/dashboard/` 返回 401、只有 assets 是 200**——面板压根打不开。
 *   这个组合光看单测看不出来（单测直接请求 assets 与 API，从不请求面板根路径）。
 * - 把整个 `/dashboard` 放进 `skip_auth` 又太宽：它是个**前缀**匹配
 *   （`serverAuth` 用 `originalUrl.startsWith`），`/dashboard/anything` 都会免鉴权
 *   ——而 `/dashboard` 恰好是适配器（`Bot.express` / `Bot.wsf`）可以注册路径的地方，
 *   等于白白放宽了别人的路由。
 *
 * 所以这里不靠 `skip_auth`，而是**只认「入口文档」这一个形状**：
 * 只对 `GET/HEAD` 的 `/dashboard` 与 `/dashboard/` 放行，其余 `/dashboard/**`
 * 一律 `next()` 交给宿主的鉴权链路。资源前缀仍然走 `skip_auth`（它本来就是那种机制）。
 *
 * # 安全边界
 *
 * 入口文档里没有任何密钥（密钥只在 `/api/v1/*` 的响应里，那些路径仍然要令牌）。
 * 另外门卫保证「启用 WebUI 必须有非空 `auth`」，所以不存在
 * "放行了文档就等于整个端口敞开"的部署。
 *
 * @param {string} distDir 构建产物目录
 * @param {{ log: (level: string, content: unknown) => void }} deps 打日志
 * @returns {{ mode: "dist"|"missing", middleware: import("express").RequestHandler }} 结果
 */
function mountFrontend(distDir, { log }) {
  const indexFile = path.join(distDir, "index.html")
  if (!fs.existsSync(indexFile)) {
    log("warn", [
      `面板前端还没构建：找不到 ${indexFile}。`,
      "面板的 API 仍然可用；要出界面请在 dashboard/ 目录下构建：",
      "  pnpm -C dashboard install && pnpm -C dashboard build",
    ])
    return { mode: /** @type {const} */ ("missing"), middleware: (req, res, next) => next() }
  }

  // 资源用 express 静态服务。`index: false`：入口文档由下面那一层专门负责
  // （否则 `/dashboard/` 会被它用默认的 index.html 兜走，
  //  那一步就绕过了我们对"只有根路径放行文档"的判断）。
  const assets = express.static(distDir, { index: false })

  /**
   * 前端中间件本体：先试静态资源，再认入口文档，都不中就走下一层。
   *
   * ⚠️ **挂在根上**（`app.use(middleware)`），路径判断自己做。
   * 别改成 `app.use(UI_PREFIX, middleware)`：实测在 express 5 下那一层
   * **不被匹配**（`earlyProbe` 明明放行了 `/dashboard/`、`online=2`，
   * 紧随其后的挂载层却从不进入，请求就此挂住到客户端超时）。
   * 同一个前缀判断 `earlyProbe` 挂在根上一直是好的，所以这里照它的做法：
   * 自己比对前缀、自己算出"前缀之内"的相对路径。
   *
   * ⚠️ **必须声明成 3 个形参**：express 按函数的 `length` 分发，
   * 3 个是普通中间件，4 个才是错误处理。写成 `assets(req, res, 回调)`（arity 2）时
   * `express.static` 会被整层**静默跳过**，请求没有任何一层答复——
   * 表现为每个用例都超时。所以 `next` 只作为形参传下去。
   *
   * @param {import("express").Request} req 请求
   * @param {import("express").Response} res 响应
   * @param {import("express").NextFunction} next 下一个中间件
   * @returns {void} 无
   */
  const middleware = (req, res, next) => {
    const url = req.originalUrl || req.url || "/"
    // 只有面板自己的前缀归这一层管；其余一律透传（既有路径的行为一字不变）
    if (url !== UI_PREFIX && !url.startsWith(`${UI_PREFIX}/`)) return next()

    // 前缀之内的相对路径：`/dashboard`→''、`/dashboard/`→'/'、`/dashboard/a.js`→'/a.js'
    const sub = url.slice(UI_PREFIX.length).split("?")[0]

    // `express.static` 是**相对 `req.url`** 找文件的，所以调用它期间把
    // `req.url` 临时换成相对路径（与 express 自己挂载子应用时的做法一致），
    // 结束后无论成败都还原——否则后面各层（access 日志、宿主兜底）会看到错的路径。
    const originalUrl = req.url
    req.url = sub === "" ? "/" : sub
    assets(req, res, err => {
      req.url = originalUrl
      if (err) return next(err)

      // 静态服务已经答复过就到此为止
      if (res.headersSent || res.writableEnded) return
      if (req.method !== "GET" && req.method !== "HEAD") return next()

      // 入口就是 "" 与 "/" 两个形状。
      // 其余路径**不放行**：`/dashboard/**` 是适配器可以注册的地方，那会越界。
      if (sub !== "" && sub !== "/") return next()

      res.sendFile(indexFile, sendErr => {
        if (sendErr) next(sendErr)
      })
    })
  }

  return { mode: /** @type {const} */ ("dist"), middleware }
}

/**
 * `/api/v1` 的错误处理：把 body 解析器的错误映射成 JSON，其余一律 500 JSON。
 *
 * 为什么需要：全局的 `express.json()` 在链上比 API 更早，它抛出的
 * `PayloadTooLargeError` 会一路传到宿主的 `serverError`——那里的处理是
 * `res.end()`，即**一个 200 空响应**。对 API 客户端来说这是最难排查的一种失败。
 * 所以未预期的错误也在这里就地收掉（只记日志），而不是再转发给宿主。
 *
 * @param {any} err 错误
 * @param {import("express").Request} req 请求对象
 * @param {import("express").Response} res 响应对象
 * @param {import("express").NextFunction} next 下一个错误处理（签名必须保留四个形参）
 * @returns {void} 无
 */
function apiErrorHandler(err, req, res, next) {
  if (err?.type === "entity.too.large")
    return sendJSON(res, 413, { code: "payload_too_large", message: "请求体过大" })
  if (err?.type === "entity.parse.failed")
    return sendJSON(res, 400, { code: "bad_request", message: "请求体不是合法的 JSON" })
  if (typeof err?.status === "number" && err.status < 500)
    return sendJSON(res, err.status, { code: "bad_request", message: String(err.message ?? err) })

  Bot.makeLog("error", ["WebUI API 错误", err], `${req.method} ${req.originalUrl}`)
  sendJSON(res, 500, { code: "internal_error", message: String(err?.message ?? err) })
}

/** 全局单例。`lib/bot.js` 直接引用它，避免每处各建一份挂载状态。 */
export default new WebUI()
