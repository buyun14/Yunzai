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

/**
 * 设置进程标题（`ps` / 任务管理器里能看到的那一行）。
 *
 * 刻意只留程序名与版本：标题里写作者名与 © 年份是框架作者的个人化痕迹，
 * 对运维没有任何信息量，而这个进程归属于谁、跑的是哪个分支由部署方决定。
 */
process.title = `Yunzai v${cfg.package.version}`

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

// 启动横幅：只说「这是什么、什么版本」，不带外部仓库地址与装饰性颜文字
// （那些是框架作者的个人化痕迹，对排障没有信息量）
logger.mark(`Yunzai v${cfg.package.version} 启动中...`)

/**
 * 死依赖的告警期提示（BCR-0001）。
 *
 * `sequelize` / `sqlite3` 在 `package.json` 里声明，但全仓零引用（含 `plugins/` 与
 * `miao-plugin`）；`db.yaml` 被读成 `cfg.db` 之后也没有任何消费方。它们唯一的作用是
 * 让人以为“本仓支持关系型数据库”，而代价是 `pnpm i` 要多装 501 个包。
 *
 * 已决策删除，但那是**破坏性变更**：声明了这些依赖的未知第三方插件会直接崩。
 * 因此按 `99-compat-and-migration.md` 的 BCR-0001 先告警、发布两个版本后再移除。
 *
 * 只在 `init()` 里打一次，不放在模块顶层——模块顶层每次 import 都会执行，
 * 单测、脚本、`node -e` 都会被刷一遍。
 */
function warnDeprecatedDeps() {
  logger.warn(
    "db.yaml 与 sequelize / sqlite3 依赖已废弃：本仓无任何代码使用它们，将在两个版本后移除（BCR-0001）。",
  )
  logger.warn("若你的插件依赖它们，请改为自带依赖，并在移除前提出来。")
}

let stack
export default async function init() {
  if (stack !== undefined) return
  stack = ""

  warnDeprecatedDeps()

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
