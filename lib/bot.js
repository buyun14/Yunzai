import init from "./config/init.js"
import cfg from "./config/config.js"
import { registerAdapter } from "./adapter/registry.js"
import PluginsLoader from "./plugins/loader.js"
import ListenerLoader from "./listener/loader.js"
import WebUI from "./web/server.js"
import { EventEmitter } from "events"
import util from "./util.js"
import express from "express"
import compression from "compression"
import http from "node:http"
import { WebSocketServer } from "ws"
import fs from "node:fs/promises"
import fetch from "node-fetch"
import { ulid } from "ulid"

/**
 * `Bot.uin`：既当账号数组用（length / slice / some / 展开），又覆盖了三个方法。
 *
 * 为什么必须显式声明：`Object.assign([], {...})` 在这里被推断成**只剩对象字面量**，
 * 数组那半边的方法与索引签名全没了，于是方法体里 `this.length` / `this.slice(...)` /
 * `this.some(...)` 一共 9 处报 TS2339。
 *
 * 注意对象字面量部分**不能写成全可选**（如只留 `now?`）：属性全可选的对象类型
 * 会被 TS 当弱类型从交叉里约简掉（这个坑在 `lib/util.js` 的 DebounceState 注释里也记了）。
 * 这里 `toJSON` / `toString` / `includes` 是必选，因此不会被约简。
 *
 * @typedef {string[] & {
 *   now?: string,
 *   toJSON(): any,
 *   toString(raw?: any, ...args: any[]): any,
 *   includes(value: any): boolean,
 * }} UinArray
 */

export default class Yunzai extends EventEmitter {
  stat = { start_time: Date.now() / 1000, online: 0 }
  bot = this
  bots = {}
  /** @type {UinArray} */
  uin = Object.assign([], {
    /**
     * 取一个可用的账号：0 个返回空串，1~2 个返回最后一个，否则随机取一个并缓存一分钟。
     * `@this` 是必需的：否则这里的 `this` 是那个对象字面量，`length` / `slice` 都不存在。
     * @this {UinArray}
     */
    toJSON() {
      if (!this.now) {
        switch (this.length) {
          case 0:
            return ""
          case 1:
          case 2:
            return this[this.length - 1]
        }
        const array = this.slice(1)
        this.now = array[Math.floor(Math.random() * array.length)]
        setTimeout(() => delete this.now, 60000)
      }
      return this.now
    },
    /** @this {UinArray} */
    toString(raw, ...args) {
      // 原来的写法是 `this.__proto__.toString`；改用 Object.getPrototypeOf 是等价写法
      // （`__proto__` 是 Annex B 的访问器，TS 的类型里没有它），且语义更明确——
      // 这里就是要拿数组原型上的原生 toString，避开本对象覆盖的那个。
      return raw === true
        ? Object.getPrototypeOf(this).toString.apply(this, args)
        : this.toJSON().toString(raw, ...args)
    },
    /** @this {UinArray} */
    includes(value) {
      return this.some(i => i == value)
    },
  })
  adapter = Object.defineProperty([], "push", {
    configurable: true,
    writable: true,
    value(...items) {
      for (const item of items)
        if (!item?.path || !this.some(adapter => adapter.path === item.path)) {
          Array.prototype.push.call(this, item)
          // 只登记真正进了数组的适配器，保证索引与数组一致；
          // 索引的用途与取舍见 lib/adapter/registry.js
          registerAdapter(item)
        }
      return this.length
    },
  })

  express = (() => {
    // 先把应用造出来：`skip_auth` 是个**前缀数组**，WebUI 的前端中间件要往里追加
    // `/dashboard/assets`（`<script>` / `<link>` 带不了自定义请求头）。
    //
    // ⚠️ 必须先把 app 赋值给一个**已初始化完**的局部变量再用它。
    // 不能写成 `.use(WebUI.frontend.bind(WebUI, { skipAuth: app.skip_auth }))` 直接挂在
    // `const app = Object.assign(...)` 的返回值上——那样 `app` 还在自己的初始化表达式里，
    // 处于暂时性死区（TDZ），读 `app.skip_auth` 抛 ReferenceError，
    // 而这个异常在字段初始化里被吞掉：**整条 `.use` 链静默少挂一层**，
    // 表现为 `/dashboard/` 与 `/api/v1/*` 全部挂起直到客户端超时（实测踩过）。
    const app = Object.assign(express(), { skip_auth: [], quiet: [] })

    // WebUI 的早期探针必须排在 serverAuth **之前**：后者在 stat.online !== 2 时
    // 会把请求挂起等 online 事件，那样任何"就绪探针"都到不了终点（前端只能看到一直转圈）。
    // 未启用 WebUI 时它是纯透传，不影响任何既有路径。
    app.use(WebUI.earlyProbe.bind(WebUI))

    // 面板前端同样必须在 serverAuth **之前**：浏览器打开面板时第一个请求就是
    // HTML 文档（浏览器不会给它带自定义头），`<script>` / `<link>` 也一样。
    // 这一层挂在根上、自己判断 `/dashboard` 前缀（与 earlyProbe 同一个做法），
    // 只放行入口文档与 `/dashboard/assets`，其余 `/dashboard/**` 与所有 API 路径照旧要令牌。
    // 未启用时它是纯透传，不影响任何既有路径。
    app.use(WebUI.frontend({ skipAuth: app.skip_auth }))

    return app
      .use(this.serverAuth.bind(this))
      .use(compression())
      .use("/status", this.serverStatus.bind(this))
      .use(express.urlencoded({ extended: false }))
      .use(express.json())
      .use(express.raw())
      .use(express.text())
      .use(this.serverHandle.bind(this))
      .use("/exit", this.serverExit.bind(this))
      .use("/File", this.fileSend.bind(this))
  })()

  server = http
    .createServer(this.express)
    .on(
      "error",
      /** @param {NodeJS.ErrnoException} err */
      err => {
        if (typeof this[`server${err.code}`] === "function") return this[`server${err.code}`](err)
        util.makeLog("error", err, "Server")
      },
    )
    .on("upgrade", this.wsConnect.bind(this))

  wss = new WebSocketServer({ noServer: true })
  wsf = Object.create(null)
  fs = Object.create(null)
  fileTimers = new Map()

  constructor() {
    super()
    /**
     * 构造函数返回的是**代理 `this.bots` 的 Proxy**，而不是本类的实例：
     * 于是 `Bot.xxx` 会依次落到 this、util、各账号对象上。这是刻意的设计。
     *
     * TS 要求构造函数的返回值可赋值给实例类型，而这个 Proxy 在结构上并不满足
     * （它只有各账号对象的字段），所以只能在这里`any` 掉。
     * 影响面很小：调用方 `new Bot()` 拿到的仍是 `Yunzai` 实例类型，
     * 只有这一个返回表达式不受检查。
     */
    return /** @type {any} */ (
      new Proxy(this.bots, {
        get: (target, prop) => {
          const value = this[prop] ?? util[prop] ?? target[prop]
          if (value !== undefined) return value
          // prop 可能是 Symbol（框架或插件会用 Bot[Symbol.iterator] /
          // Bot[Symbol.toStringTag] 之类做探测），而模板字符串对 Symbol 求值会抛
          // TypeError: Cannot convert a Symbol value to a string。
          // 那不是在"打日志时失败"，而是在 Proxy 内部直接抛异常、堆栈还指向调用方，
          // 极难排查。因此这里必须显式 String(prop)。
          for (const i of [this.uin.toString(), ...this.uin])
            if (target[i]?.[prop] !== undefined) {
              util.makeLog(
                "trace",
                `因不存在 Bot.${String(prop)} 而重定向到 Bot.${i}.${String(prop)}`,
              )
              if (typeof target[i][prop]?.bind === "function")
                return target[i][prop].bind(target[i])
              return target[i][prop]
            }
          util.makeLog("trace", `不存在 Bot.${String(prop)}`)
        },
      })
    )
  }

  serverAuth(req) {
    if (this.stat.online !== 2) return this.once("online", this.serverAuth.bind(this, req))

    req.rid ??= `${req.ip}:${req.socket.remotePort}`
    req.sid ??= `${req.protocol}://${req.hostname}:${req.socket.localPort}${req.originalUrl}`
    if (!cfg.server.auth || !Object.keys(cfg.server.auth).length) return req.next?.()

    for (const i of req.app?.skip_auth || []) if (req.originalUrl.startsWith(i)) return req.next()

    for (const i in cfg.server.auth) {
      if (
        req.headers[i.toLowerCase()] === cfg.server.auth[i] ||
        req.query[i] === cfg.server.auth[i]
      )
        continue
      req.res?.sendStatus(401)

      const msg = { headers: req.headers }
      if (Object.keys(req.query).length) msg.query = req.query
      util.makeLog(
        "error",
        ["HTTP", req.method, "请求", i, "鉴权失败", msg],
        `${req.sid} <≠ ${req.rid}`,
        true,
      )
      return false
    }
    req.next?.()
  }

  serverStatus(req) {
    req.res.type("json")
    req.res.send(
      JSON.stringify(process.report.getReport()).replace(
        /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g,
        "[IPv4]",
      ),
    )
  }

  serverHandle(req) {
    let quiet = false
    for (const i of req.app.quiet)
      if (req.originalUrl.startsWith(i)) {
        quiet = true
        break
      }

    const msg = { headers: req.headers }
    for (const i of ["query", "body"]) if (req[i] && Object.keys(req[i]).length) msg[i] = req[i]
    util.makeLog(
      quiet ? "debug" : "mark",
      ["HTTP", req.method, "请求", msg],
      `${req.sid} <= ${req.rid}`,
      true,
    )
    req.next()
  }

  async serverExit(req) {
    if (req.ip !== "::1" && req.ip !== "::ffff:127.0.0.1") return
    this.exit(1)
  }

  wsConnect(req, socket, head) {
    if (this.stat.online !== 2)
      return this.once("online", this.wsConnect.bind(this, req, socket, head))

    req.rid = `${req.socket.remoteAddress}:${req.socket.remotePort}-${req.headers["sec-websocket-key"]}`
    req.sid = `ws://${req.headers["x-forwarded-host"] || req.headers.host || `${req.socket.localAddress}:${req.socket.localPort}`}${req.url}`
    req.query = Object.fromEntries(new URL(req.sid).searchParams.entries())
    if (this.serverAuth(req) === false) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      return socket.destroy()
    }

    const msg = { headers: req.headers }
    if (Object.keys(req.query).length) msg.query = req.query

    const path = req.url.split("/")[1]
    if (!(path in this.wsf)) {
      util.makeLog(
        "error",
        ["WebSocket 处理器", path, "不存在", msg],
        `${req.sid} <≠> ${req.rid}`,
        true,
      )
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n")
      return socket.destroy()
    }

    this.wss.handleUpgrade(req, socket, head, conn => {
      util.makeLog("mark", ["建立连接", msg], `${req.sid} <=> ${req.rid}`, true)
      conn.on("error", (...args) => util.makeLog("error", args, `${req.sid} <=> ${req.rid}`, true))
      conn.on("close", () => {
        util.makeLog("mark", "断开连接", `${req.sid} <≠> ${req.rid}`, true)
        this.cleanupBotConnection(conn)
      })
      conn.on("message", msg =>
        util.makeLog("debug", ["消息", util.String(msg)], `${req.sid} <= ${req.rid}`, true),
      )
      conn.sendMsg = msg => {
        if (!Buffer.isBuffer(msg)) msg = util.String(msg)
        util.makeLog("debug", ["消息", msg], `${req.sid} => ${req.rid}`, true)
        return conn.send(msg)
      }
      for (const i of this.wsf[path]) i(conn, req, socket, head)
    })
  }

  async serverEADDRINUSE(err, https) {
    util.makeLog(
      "error",
      ["监听端口", https ? cfg.server.https.port : cfg.server.port, "错误", err],
      "Server",
    )
    if (https) return
    try {
      await fetch(`http://localhost:${cfg.server.port}/exit`, {
        headers: cfg.server.auth || undefined,
      })
    } catch {}
    this.server_listen_time = (this.server_listen_time || 0) + 1
    await util.sleep(this.server_listen_time * 1000)
    this.server.listen(cfg.server.port, cfg.server.address || undefined)
  }

  serverError(err, req, res, next) {
    util.makeLog("error", ["HTTP", req.method, "请求错误", err], `${req.sid} <≠ ${req.rid}`, true)
    return res.end()
  }

  async serverLoad(https) {
    const server = https ? "httpsServer" : "server"
    // address 留空时传 undefined，Node 保持默认监听行为（与改造前一致）
    const bindAddress = cfg.server.address || undefined
    this[server].listen(https ? cfg.server.https.port : cfg.server.port, bindAddress)
    try {
      await util.promiseEvent(this[server], "listening", https && "error")
    } catch (err) {
      return
    }
    // 断言为 AddressInfo：这里监听的是 TCP，`address()` 只有在 unix socket 时返回字符串。
    const { address, port } = /** @type {import("node:net").AddressInfo} */ (this[server].address())
    util.makeLog(
      "mark",
      [
        `启动 HTTP${https ? "S" : ""} 服务器`,
        logger.green(`http${https ? "s" : ""}://[${address}]:${port}`),
      ],
      "Server",
    )
    this.url = (https && cfg.server.https.url) || cfg.server.url
    for (const name of [404, "timeout"])
      this.fileToUrl(`resources/http/File/${name}.jpg`, { name, time: false, times: false })
  }

  async httpsLoad() {
    try {
      this.httpsServer = (await import("node:https"))
        .createServer(
          {
            key: await fs.readFile(cfg.server.https.key),
            cert: await fs.readFile(cfg.server.https.cert),
          },
          this.express,
        )
        .on(
          "error",
          /** @param {NodeJS.ErrnoException} err */
          err => {
            if (typeof this[`server${err.code}`] === "function")
              return this[`server${err.code}`](err, true)
            util.makeLog("error", err, "Server")
          },
        )
        .on("upgrade", this.wsConnect.bind(this))
      return this.serverLoad(true)
    } catch (err) {
      util.makeLog("error", ["创建 HTTPS 服务器错误", err], "Server")
    }
  }

  async run() {
    if (this.stat.online !== 0) return
    this.stat.online = 1
    await init()
    await this.serverLoad()
    if (cfg.server.https?.key && cfg.server.https.cert) await this.httpsLoad()
    await PluginsLoader.load()
    await ListenerLoader.load()

    this.stat.online = 2
    // 必须在宿主的兜底跳转之前挂载，否则 /api/v1 永远拿不到请求
    WebUI.mount(this.express, { loader: PluginsLoader })
    this.express.use(req => req.res.redirect(cfg.server.redirect)).use(this.serverError.bind(this))
    util.makeLog(
      "info",
      `连接地址：${logger.blue(`${this.url.replace(/^http/, "ws")}/`)}${logger.cyan(`[${Object.keys(this.wsf)}]`)}`,
      "WebSocket",
    )
    this.emit("online", this)
  }

  async fileToUrl(file, opts = {}) {
    const {
      name,
      time = cfg.bot.file_to_url_time * 60000,
      times = cfg.bot.file_to_url_times,
    } = opts

    file =
      (typeof file === "object" && !Buffer.isBuffer(file) && { ...file }) ||
      (await util.fileType({ file, name }, { http: true }))
    if (!Buffer.isBuffer(file.buffer)) return file.buffer
    file.name = file.name ? encodeURIComponent(file.name) : ulid()

    if (typeof times === "number") file.times = times
    this.fs[file.name] = file
    this.setFileTimeout(file.name, file, time)

    const url = new URL(`File/${encodeURIComponent(file.name)}`, this.url)
    for (const i in cfg.server.auth) url.searchParams.set(i, cfg.server.auth[i])
    return url
  }

  setFileTimeout(name, file, time) {
    const oldTimer = this.fileTimers.get(name)
    if (oldTimer) clearTimeout(oldTimer)
    this.fileTimers.delete(name)
    if (!time) return

    const timer = setTimeout(() => {
      if (this.fileTimers.get(name) !== timer || this.fs[name] !== file) return
      this.fileTimers.delete(name)
      this.expireFile(name, file)
    }, time)
    this.fileTimers.set(name, timer)
  }

  expireFile(name, file) {
    if (this.fs[name] !== file) return
    this.fs[name] = this.fs.timeout

    const oldTimer = this.fileTimers.get(name)
    if (oldTimer) clearTimeout(oldTimer)
    const timer = setTimeout(() => {
      if (this.fs[name] === this.fs.timeout) delete this.fs[name]
      if (this.fileTimers.get(name) === timer) this.fileTimers.delete(name)
    }, 60000)
    this.fileTimers.set(name, timer)
  }

  cleanupBotConnection(ws) {
    for (const [self_id, bot] of Object.entries(this.bots)) {
      if (bot.ws !== ws) continue
      delete this.bots[self_id]
      for (let i = this.uin.length - 1; i >= 0; i--)
        if (this.uin[i] == self_id) this.uin.splice(i, 1)
      if (this.uin.now == self_id) delete this.uin.now
    }
  }

  fileSend(req) {
    const url = req.path.replace(/^\//, "")
    let file = this.fs[url] || this.fs[404]

    if (typeof file.times === "number") {
      if (file.times > 0) {
        file.times--
        if (file.times <= 0) this.expireFile(url, file)
      } else {
        this.expireFile(url, file)
        file = this.fs.timeout
      }
    }

    if (file.type?.mime) req.res.setHeader("Content-Type", file.type.mime)

    util.makeLog(
      "mark",
      `发送文件：${file.name}(${file.url} ${(file.buffer.length / 1024).toFixed(2)}KB)`,
      `${req.sid} => ${req.rid}`,
      true,
    )
    req.res.send(file.buffer)
  }

  prepareEvent(data) {
    if (!this.bots[data.self_id]) return
    if (!data.bot)
      Object.defineProperty(data, "bot", {
        value: this.bots[data.self_id],
      })

    if (data.user_id) {
      if (!data.friend)
        Object.defineProperty(data, "friend", {
          value: data.bot.pickFriend(data.user_id),
        })
      data.sender ||= { user_id: data.user_id }
      data.sender.nickname ||= data.friend.name || data.friend.nickname
    }

    if (data.group_id) {
      if (!data.group)
        Object.defineProperty(data, "group", {
          value: data.bot.pickGroup(data.group_id),
        })
      data.group_name ||= data.group.name || data.group.group_name
    }

    if (data.group && data.user_id) {
      if (!data.member)
        Object.defineProperty(data, "member", {
          value: data.group.pickMember(data.user_id),
        })
      data.sender.nickname ||= data.member.name || data.member.nickname
      data.sender.card ||= data.member.card
    }

    if (data.bot.adapter?.id) data.adapter_id = data.bot.adapter.id
    if (data.bot.adapter?.name) data.adapter_name = data.bot.adapter.name

    for (const i of [data.friend, data.group, data.member]) {
      if (typeof i !== "object") continue
      i.sendFile ??= (file, name) => i.sendMsg(segment.file(file, name))
      i.makeForwardMsg ??= this.makeForwardMsg
      i.sendForwardMsg ??= msg => this.sendForwardMsg(msg => i.sendMsg(msg), msg)
      i.getInfo ??= () => i.info || i
    }

    if (!data.reply) {
      if (data.group?.sendMsg) data.reply = data.group.sendMsg.bind(data.group)
      else if (data.friend?.sendMsg) data.reply = data.friend.sendMsg.bind(data.friend)
    }
  }

  em(name = "", data = {}) {
    this.prepareEvent(data)
    while (true) {
      this.emit(name, data)
      const i = name.lastIndexOf(".")
      if (i === -1) break
      name = name.slice(0, i)
    }
  }

  getFriendArray() {
    const array = []
    for (const bot_id of this.uin)
      for (const [, i] of this.bots[bot_id].fl || []) array.push({ ...i, bot_id })
    return array
  }

  getFriendList() {
    const array = []
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].fl?.keys() || []))
    return array
  }

  getFriendMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].fl || []) map.set(id, { ...i, bot_id })
    return map
  }
  get fl() {
    return this.getFriendMap()
  }

  getGroupArray() {
    const array = []
    for (const bot_id of this.uin)
      for (const [, i] of this.bots[bot_id].gl || []) array.push({ ...i, bot_id })
    return array
  }

  getGroupList() {
    const array = []
    for (const bot_id of this.uin) array.push(...(this.bots[bot_id].gl?.keys() || []))
    return array
  }

  getGroupMap() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gl || []) map.set(id, { ...i, bot_id })
    return map
  }
  get gl() {
    return this.getGroupMap()
  }
  get gml() {
    const map = new Map()
    for (const bot_id of this.uin)
      for (const [id, i] of this.bots[bot_id].gml || [])
        map.set(id, Object.assign(new Map(i), { bot_id }))
    return map
  }

  pickFriend(user_id, strict) {
    user_id = Number(user_id) || user_id
    if (this.bots[this.uin]?.fl.has(user_id)) return this.bots[this.uin].pickFriend(user_id)

    let user
    for (const bot_id of this.uin)
      for (const [id, info] of this.bots[bot_id]?.fl || [])
        if (id === user_id) user = { ...info, bot_id }

    if (!user) {
      const memberMaps = new Map()
      for (const bot_id of this.uin)
        for (const [group_id, members] of this.bots[bot_id]?.gml || [])
          memberMaps.set(group_id, { bot_id, members })

      for (const { bot_id, members } of memberMaps.values()) {
        user = members.get(user_id)
        if (user) {
          user.bot_id = bot_id
          break
        }
      }
    }

    if (user) return this.bots[user.bot_id].pickFriend(user_id)
    if (strict) return false
    util.makeLog("debug", ["因不存在用户", user_id, "而随机选择Bot", this.uin.toJSON()])
    return this.bots[this.uin].pickFriend(user_id)
  }
  get pickUser() {
    return this.pickFriend
  }

  pickGroup(group_id, strict) {
    group_id = Number(group_id) || group_id
    if (this.bots[this.uin]?.gl.has(group_id)) return this.bots[this.uin].pickGroup(group_id)

    let group
    for (const bot_id of this.uin)
      for (const [id, info] of this.bots[bot_id]?.gl || [])
        if (id === group_id) group = { ...info, bot_id }

    if (group) return this.bots[group.bot_id].pickGroup(group_id)
    if (strict) return false
    util.makeLog("debug", ["因不存在群", group_id, "而随机选择Bot", this.uin.toJSON()])
    return this.bots[this.uin].pickGroup(group_id)
  }

  pickMember(group_id, user_id) {
    return this.pickGroup(group_id).pickMember(user_id)
  }

  sendFriendMsg(bot_id, user_id, ...args) {
    try {
      if (!bot_id) return this.pickFriend(user_id).sendMsg(...args)

      if (this.uin.includes(bot_id) && this.bots[bot_id])
        return this.bots[bot_id].pickFriend(user_id).sendMsg(...args)

      if (!args.length && this.pickFriend(bot_id, true))
        return this.pickFriend(bot_id).sendMsg(user_id)

      const { promise, resolve, reject } = Promise.withResolvers()
      const listener = data => {
        resolve(data.bot.pickFriend(user_id).sendMsg(...args))
        clearTimeout(timeout)
      }
      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"), { bot_id, user_id, args }))
        this.off(`connect.${bot_id}`, listener)
      }, 300000)
      this.once(`connect.${bot_id}`, listener)
      return promise
    } catch (err) {
      util.makeLog("error", ["发送好友消息错误", args, err], `${bot_id} => ${user_id}`, true)
    }
  }

  sendGroupMsg(bot_id, group_id, ...args) {
    try {
      if (!bot_id) return this.pickGroup(group_id).sendMsg(...args)

      if (this.uin.includes(bot_id) && this.bots[bot_id])
        return this.bots[bot_id].pickGroup(group_id).sendMsg(...args)

      if (!args.length && this.pickGroup(bot_id, true))
        return this.pickGroup(bot_id).sendMsg(group_id)

      const { promise, resolve, reject } = Promise.withResolvers()
      const listener = data => {
        resolve(data.bot.pickGroup(group_id).sendMsg(...args))
        clearTimeout(timeout)
      }
      const timeout = setTimeout(() => {
        reject(Object.assign(Error("等待 Bot 上线超时"), { bot_id, group_id, args }))
        this.off(`connect.${bot_id}`, listener)
      }, 300000)
      this.once(`connect.${bot_id}`, listener)
      return promise
    } catch (err) {
      util.makeLog("error", ["发送群消息错误", args, err], `${bot_id} => ${group_id}`, true)
    }
  }

  /**
   * 等待一条文本消息。
   *
   * `fnc` 既可以是判定函数，也可以是 `{ self_id, user_id }`（此时内部会合成判定函数）。
   *
   * 必须写 JSDoc：默认值 `() => true` 会被 TS 推断成**零参**函数，
   * 于是下面 `fnc(data)` 报 TS2554，重新赋值也会因参数个数不符而报错。
   *
   * @param {((data: any) => any) | { self_id?: any, user_id?: any }} [fnc]
   * @returns {Promise<string>}
   */
  getTextMsg(fnc = () => true) {
    if (typeof fnc !== "function") {
      const { self_id, user_id } = fnc
      fnc = data => data.self_id == self_id && data.user_id == user_id
    }

    const { promise, resolve } = Promise.withResolvers()
    const listener = data => {
      try {
        if (!fnc(data)) return

        let msg = ""
        for (const i of data.message) if (i.type === "text" && i.text) msg += i.text.trim()
        if (!msg) return

        resolve(msg)
        this.off("message", listener)
      } catch (err) {
        util.makeLog("error", err, data.self_id)
      }
    }
    this.on("message", listener)
    return promise
  }

  getMasterMsg() {
    return this.getTextMsg(data => cfg.master[data.self_id]?.includes(String(data.user_id)))
  }

  async sendMasterMsg(msg, bot_array = Object.keys(cfg.master), sleep = 5000) {
    const ret = {}
    await Promise.allSettled(
      (Array.isArray(bot_array) ? bot_array : [bot_array]).map(async bot_id => {
        ret[bot_id] = {}
        for (const user_id of cfg.master[bot_id] || []) {
          ret[bot_id][user_id] = this.sendFriendMsg(bot_id, user_id, msg)
          if (sleep) await util.sleep(sleep, ret[bot_id][user_id])
        }
      }),
    )
    return ret
  }

  makeForwardMsg(msg) {
    return { type: "node", data: msg }
  }

  makeForwardArray(msg = [], node = {}) {
    const forward = []
    for (const message of Array.isArray(msg) ? msg : [msg]) forward.push({ ...node, message })
    return this.makeForwardMsg(forward)
  }

  async sendForwardMsg(send, msg) {
    const messages = []
    for (const { message } of Array.isArray(msg) ? msg : [msg]) messages.push(await send(message))
    return messages
  }

  async redisExit() {
    if (!(typeof redis === "object" && redis.process)) return false
    const p = redis.process
    delete redis.process
    await util.sleep(
      5000,
      redis.save().catch(() => {}),
    )
    return p.kill()
  }

  async exit(code = 0) {
    await this.redisExit()
    switch (global.start_type) {
      case "pm2":
        return util.exec("pnpm stop")
      case "external":
        return process.exit(255)
    }
    process.exit(code)
  }

  async restart() {
    await this.redisExit()
    if (process.platform !== "win32") process.execve?.(process.argv[0], process.argv, process.env)

    switch (global.start_type) {
      case "pm2":
        await util.exec("pnpm run restart")
        break
      case "internal":
        util.cmdStart(process.argv[0], process.argv.slice(1))
        break
    }
    process.exit()
  }
}
