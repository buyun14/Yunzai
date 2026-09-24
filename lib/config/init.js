import setLog from "./log.js"
import cfg from "./config.js"
import redisInit from "./redis.js"

if (!Promise.withResolvers) {
  const { deprecate } = await import("node:util")
  /**
   * `Promise.withResolvers` 的补丁。
   *
   * 说明两点：
   * 1. 本仓 `engines.node` 是 `>=22.12`，而 `Promise.withResolvers` 在 Node 22
   *    就已内置，所以这个分支实际上**永远不会执行**；留着它是为了兼容旧运行环境的习惯。
   * 2. 返回值必须显式标注：`r` 先是 `{}`，`resolve` / `reject` 是在 Promise
   *    执行器回调里挂上去的，TS 的控制流分析看不到那一步，会把返回类型推成
   *    `{ promise }`，于是整个赋值与 `Promise.withResolvers` 的签名对不上（TS2322）。
   */
  Promise.withResolvers = deprecate(() => {
    /** @type {PromiseWithResolvers<any>} */
    const r = /** @type {any} */ ({
      promise: Promise.resolve(),
    })
    r.promise = new Promise((resolve, reject) => {
      r.resolve = resolve
      r.reject = reject
    })
    return r
  }, "请更新 Node.js")
}

/** 设置标题 */
process.title = `TRSS Yunzai v${cfg.package.version} © 2023 - 2026 TimeRainStarSky`

/** 设置时区 */
process.env.TZ = "Asia/Shanghai"

for (const i of ["SIGHUP", "SIGTERM"]) process.on(i, (signal, code) => process.exit(code))

/** 日志设置 */
setLog()

/** 捕获未处理的错误 */
for (const i of ["uncaughtException", "unhandledRejection"])
  process.on(i, e => {
    try {
      Bot.makeLog("error", e, i)
    } catch (err) {
      console.error(i, e, err)
      process.exit()
    }
  })

logger.mark("----^_^----")
logger.mark(logger.yellow(`TRSS-Yunzai v${cfg.package.version} 启动中...`))
logger.mark(logger.cyan("https://git.trss.me/Yunzai"))

let stack
export default async function init() {
  if (stack !== undefined) return
  stack = ""

  // 只需要它的副作用（设置 global.redis），返回值本身不用
  await redisInit()
  const exit = process.exit
  process.exit = code => {
    stack = Error().stack
    return exit(code)
  }

  /** 退出事件 */
  process.on("exit", code => {
    Bot.makeLog(
      "mark",
      logger.magenta(`TRSS-Yunzai 已停止运行，本次运行时长：${Bot.getTimeDiff()} (${code})`),
      "exit",
    )
    Bot.makeLog("trace", stack || Error().stack, "exit")
  })
}
