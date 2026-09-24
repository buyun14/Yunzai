import { spawn } from "node:child_process"
import { sendJSON } from "../security.js"

/**
 * 进程控制：重启 / 停止（v3 的第一块，也是面板上最常用的运维动作）。
 *
 * # 为什么这两条路径特别危险
 *
 * 它们**能把服务停掉**。如果面板暴露在公网上、而有人（或误操作）点了停止，
 * 服务不会自己回来——那是"删库级"的后果。所以：
 *
 * 1. **只允许本机与局域网来源**。判断依据是 `req.socket.remoteAddress`。
 *    拒绝时返回 403 而不是 401：401 会让人以为"令牌填错了"，从而去反复试令牌，
 *    而真正的原因是"你这个来源不允许做这件事"。
 *    ⚠️ 如果以后要支持公网运维，正确做法是**经过 VPN / 隧道**，
 *    而不是在这里放宽判断——放宽等于给公网一个关机按钮。
 * 2. **重启优于停止**：重启会自己回来，停止不会。界面上给停止加二次确认。
 *
 * # 重启为什么不是 `Bot.restart()`
 *
 * 内核的 `Bot.restart()` 按 `global.start_type` 分支：`pm2` 走 `pnpm run restart`、
 * `internal` 用 `util.cmdStart`、`external` 在外 **`execve` 之后就直接 `process.exit()`**
 * ——那条路径在 Windows 上没有 `execve`，于是**进程直接死掉、不会回来**。
 *
 * 面板不依赖启动方式、也不依赖 pm2：先关掉自己的 HTTP server（把端口腾出来），
 * 再用 `spawn(detached)` 拉起一个和当前**完全相同命令行**的新进程，然后退出。
 *
 * ⚠️ 顺序不能反，也不能"先退出再拉起"：`lib/bot.js` 的 `serverEADDRINUSE()`
 * 在端口被占用时会向占用者**发一个 `/exit`**。所以新进程必须等老进程
 * 真的放开端口之后再起来。
 *
 * # 为什么要先回响应再动手
 *
 * 进程一重启，连接就断了。先 `sendJSON(202)` 把结果告诉前端，再延迟几百毫秒
 * 执行真实的动作——这样前端能拿到明确的"已受理"，而不是一个网络错误。
 */

/** 允许执行进程控制的来源：本机 + 私有网段 */
const LOCAL_PATTERNS = [
  /^::1$/,
  /^127\./,
  /^::ffff:127\./,
  /^10\./,
  /^192\.168\./,
  /^::ffff:192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
]

/**
 * 取请求来源地址。
 *
 * 刻意**不读 `X-Forwarded-For`**：那个头是客户端可伪造的，而"这个头说我是内网"
 * 就能拿到关机按钮，等于没有防护。只有直连地址算数。
 *
 * @param {import("express").Request} req 请求
 * @returns {string} 地址
 */
function addressOf(req) {
  return String(req.socket?.remoteAddress ?? req.ip ?? "")
}

/**
 * 该来源是否允许执行进程控制。
 *
 * @param {import("express").Request} req 请求
 * @returns {boolean} 是否允许
 */
export function isLocalAddress(req) {
  const address = addressOf(req)
  return LOCAL_PATTERNS.some(pattern => pattern.test(address))
}

/**
 * 造一个"仅本机/内网可调用"的闸门中间件。
 *
 * @returns {import("express").RequestHandler} 中间件
 */
export function createLocalOnlyGate() {
  return (req, res, next) => {
    if (isLocalAddress(req)) return next()
    sendJSON(res, 403, {
      code: "forbidden",
      message: `出于安全，重启与停止只允许从本机或内网调用（当前来源：${addressOf(req)}）。远程运维请走 VPN 或隧道`,
    })
  }
}

/**
 * 造重启处理器。
 *
 * @param {object} [deps] 依赖
 * @param {() => object|undefined} [deps.hostOf] 取宿主对象
 * @param {() => string[]} [deps.argvOf] 取当前进程的启动参数（测试可注入）
 * @param {(file: string, args: string[], opts: object) => { unref?: () => void }} [deps.spawnOf] 拉起新进程（测试可注入）
 * @param {number} [deps.delay] 延迟多久真正动手（毫秒）
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createRestartHandler({
  hostOf = () => /** @type {any} */ (globalThis.Bot),
  argvOf = () => process.argv.slice(1),
  spawnOf = (file, args, opts) => spawn(file, args, opts),
  delay = 500,
} = {}) {
  return (req, res) => {
    // 先把话说明白：这次请求之后连接会断，所以先把"已受理"发出去
    sendJSON(res, 202, {
      code: "accepted",
      action: "restart",
      message: "已受理，正在重启；几秒后刷新页面，或看日志确认",
    })

    // 延迟是因为响应还在飞：立刻动手指的是"把连接掐了、前端只看到一个网络错误"
    setTimeout(() => {
      void restartSelf({ hostOf, argvOf, spawnOf })
    }, delay)
  }
}

/**
 * 真正执行重启：腾端口 → 拉起新进程 → 自己退出。
 *
 * @param {object} deps 依赖
 * @param {() => object|undefined} deps.hostOf 取宿主对象
 * @param {() => string[]} deps.argvOf 取启动参数
 * @param {(file: string, args: string[], opts: object) => { unref?: () => void }} deps.spawnOf 拉起新进程
 * @returns {Promise<void>} 无
 */
async function restartSelf({ hostOf, argvOf, spawnOf }) {
  const host = hostOf()

  try {
    // 关掉自己的监听。不等它就把新进程拉起来的话，新进程会因为端口被占用
    // 而触发内核的 `serverEADDRINUSE()`——那个函数会向占用者（也就是我们）
    // 发一个 `/exit`，结果就是"重启把自己踢掉"。
    await new Promise(resolve => {
      const server = host?.server
      if (!server) return resolve(undefined)
      server.closeAllConnections?.()
      server.close(() => resolve(undefined))
      // 兜底：万一 close 回调不来，最多等 1.5 秒也要往下走
      setTimeout(resolve, 1500)
    })

    // detached + stdio ignore + unref：让新进程脱离本进程的进程组，
    // 这样我们退出时它不会被一起带走
    const child = spawnOf(process.execPath, argvOf(), {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref?.()
  } catch (err) {
    // 走到这里说明新进程没起来，而我们已经把监听关了——只能留下日志
    host?.makeLog?.("error", ["面板重启失败，进程即将退出且不会自动回来", err], "WebUI")
  }

  // 不再走 Bot.exit()：它会顺手关掉 redis，而新进程正要用同一个 redis
  process.exit(0)
}

/**
 * 造停止处理器。
 *
 * 停止**不会自己回来**，所以它比重启更需要用户明确知道自己在做什么——界面上的
 * 二次确认是必需的，不是装饰。
 *
 * @param {object} [opts] 选项
 * @param {() => object|undefined} [opts.hostOf] 取宿主对象
 * @param {number} [opts.delay] 延迟多久真正动手（毫秒）
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createStopHandler({
  hostOf = () => /** @type {any} */ (globalThis.Bot),
  delay = 500,
} = {}) {
  return (req, res) => {
    sendJSON(res, 202, {
      code: "accepted",
      action: "stop",
      message: "已受理，正在停止。停止后不会自动恢复，需要用你原来的方式重新启动",
    })

    setTimeout(() => {
      const host = hostOf()
      // 走内核的 exit()：它会先妥善收尾 redis（`redisExit()`），
      // 这正是"干净停止"与"直接 process.exit"的区别
      Promise.resolve(host?.exit?.() ?? process.exit(0)).catch(() => process.exit(0))
    }, delay)
  }
}

/**
 * 能力探测：让界面知道"这个部署能不能远程重启"。
 *
 * 前端据此决定是"显示按钮"还是"显示一句为什么不能点"——
 * 让用户点完才被 403 拒掉是最差的体验。
 *
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createControlCapabilitiesHandler() {
  return (req, res) => {
    sendJSON(res, 200, {
      // 来源地址是否在允许列表里
      canControl: isLocalAddress(req),
      // 停止不会自动恢复，界面要据此加二次确认
      stopIsRecoverable: false,
    })
  }
}
