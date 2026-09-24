import log4js from "log4js"
import { Chalk } from "chalk"
import cfg from "./config.js"

/**
 * 全局 `logger` 的形状：**chalk 实例 + 挂上去的 log4js 日志器**。
 *
 * `logger.blue(...)` 这类走 chalk 上色，`logger.mark(...)` / `logger.error(...)`
 * 走 log4js；而 `logger.logger.errorLogger` 直接拿到底层 log4js 日志器。
 *
 * 为什么要声明它：`logger` 这个属性是本仓自己挂到 chalk 实例上的，
 * chalk 的类型里没有，于是 `chalk.logger` 的四处读写全是 TS2339。
 *
 * 这是**既有契约、不是待清理的临时结构**——插件里到处在写 `logger.mark(...)`、
 * `logger.blue(...)`，因此本次只补类型、不改结构。
 *
 * （顺带一提：这个对象在 vitest 下的一个未解之谜记在
 * docs/refactor/baseline/startup.md 的 O6——那里的 `globalThis.logger` 读不到
 * `.logger`，而纯 node 与生产运行都正常。那条与本次的类型工作无关。）
 *
 * @typedef {import("chalk").ChalkInstance & {
 *   logger: Record<string, any>,
 * }} LoggerGlobal
 */

/**
 * log4js 的配置对象。
 *
 * 抽成独立函数是为了让 WebUI 的日志流能**追加一个 appender**，而不是复制这份配置：
 * `lib/web/api/logs.js` 会 `log4js.configure({...buildLogConfig(), appenders: {..., webui}})`。
 * 两份副本的后果是“面板上看到的日志和终端不是一套”，而那正是面板最该可信的地方。
 *
 * 三个分类的划分决定了“面板能拿到什么”：
 * `default`（trace/debug/info，受 `bot.log_level` 控制）、`command`（warn 与 mark）、
 * `error`（error/fatal）。一次日志调用只会进**一个**分类，所以给三个都挂同一个
 * appender 不会重复。
 *
 * @returns {{ appenders: Record<string, any>, categories: Record<string, { appenders: string[], level: string }> }} 配置
 */
export function buildLogConfig() {
  return {
    /**
     * 写成 `Record<string, any>` 是必须的：log4js 的 `Appender` 类型只描述了
     * `type: string` 那种写法，而它的实现还支持把整个 appender 模块（带 `configure`）
     * 直接放进来——WebUI 的日志流用的就是后者。写成 `unknown` 会让 `configure()` 报 TS2769。
     */
    appenders: /** @type {Record<string, any>} */ ({
      stderr: {
        type: "stderr",
        layout: {
          type: "pattern",
          pattern: "%[[%d{hh:mm:ss.SSS}][%4.4p]%]%m",
        },
      },
      stdout: {
        type: "stdout",
        layout: {
          type: "pattern",
          pattern: "%[[%d{hh:mm:ss.SSS}][%4.4p]%]%m",
        },
      },
      command: {
        type: "dateFile",
        filename: "logs/command",
        pattern: "yyyy-MM-dd.log",
        numBackups: 180,
        alwaysIncludePattern: true,
        layout: {
          type: "pattern",
          pattern: "[%d{hh:mm:ss.SSS}][%4.4p]%m",
        },
        compress: true,
      },
      error: {
        type: "file",
        filename: "logs/error.log",
        layout: {
          type: "pattern",
          pattern: "[%d{hh:mm:ss.SSS}][%4.4p]%m",
        },
      },
    }),
    categories: {
      default: { appenders: ["stdout"], level: cfg.bot.log_level },
      command: { appenders: ["stdout", "command"], level: "warn" },
      error: { appenders: ["stderr", "command", "error"], level: "error" },
    },
  }
}

/**
 * 设置日志样式
 */
export default function setLog() {
  /** 调整error日志等级 */
  // log4js.levels.levels[5].level = Number.MAX_VALUE
  // log4js.levels.levels.sort((a, b) => a.level - b.level)

  log4js.configure(buildLogConfig())

  /** 全局变量 logger */
  // 断言成 LoggerGlobal：`logger` 属性是本仓紧接着挂上去的，chalk 的类型里没有它
  const chalk = /** @type {LoggerGlobal} */ (new Chalk({ level: 3 }))
  chalk.logger = {
    defaultLogger: log4js.getLogger("message"),
    commandLogger: log4js.getLogger("command"),
    errorLogger: log4js.getLogger("error"),
    trace(...args) {
      return this.defaultLogger.trace(...args)
    },
    debug(...args) {
      return this.defaultLogger.debug(...args)
    },
    info(...args) {
      return this.defaultLogger.info(...args)
    },
    warn(...args) {
      return this.commandLogger.warn(...args)
    },
    error(...args) {
      return this.errorLogger.error(...args)
    },
    fatal(...args) {
      return this.errorLogger.fatal(...args)
    },
    mark(...args) {
      return this.commandLogger.mark(...args)
    },
  }
  const defid = chalk.blue(`[${cfg.bot.log_align || "TRSSYz"}]`)
  for (const i in chalk.logger)
    if (typeof chalk.logger[i] == "function")
      chalk[i] = (...args) => chalk.logger[i](defid, ...args)
  global.logger = chalk
}
