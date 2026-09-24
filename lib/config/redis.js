import cfg from "./config.js"
import { createClient } from "redis"
import { spawn } from "node:child_process"

/**
 * spawn 出来的 redis-server 句柄 + 本仓自己挂的"已退出"标记。
 *
 * `exit` 不是 Node 的字段，而是本模块用来跳出重试循环的标志（`on("exit")` 里置位）。
 *
 * 字段写成**必选**而不是可选：一个"属性全可选"的对象类型会被 TS 当弱类型
 * 从交叉里约简掉，那样 `.exit` 依旧报 TS2339（同一个坑在 `lib/util.js` 的
 * DebounceState 注释里也记了）。因此调用方需要断言，而不是指望它自动成立。
 *
 * @typedef {import("node:child_process").ChildProcessWithoutNullStreams & {
 *   exit: boolean,
 * }} RedisProcess
 */

/**
 * node-redis 客户端 + 本仓挂上去的两个字段：
 * - `class`：指回本类实例，历史契约；
 * - `process`：spawn 出来的 redis-server，断线时用来收尾。
 *
 * 同样显式列全部字段（理由见上）。用这个类型而不是把整个客户端退化成 `any`：
 * `this.redis.ping()` / `.connect()` / `.once()` 这些调用的类型检查得以保留。
 *
 * @typedef {import("redis").RedisClientType & {
 *   class: Redis,
 *   process: RedisProcess,
 * }} AugmentedRedisClient
 */

/**
 * 初始化全局redis客户端
 */
export default async function redisInit() {
  const rc = cfg.redis
  return (global.redis = await new Redis(
    {
      socket: {
        host: rc.host,
        port: rc.port,
      },
      username: rc.username,
      password: rc.password,
      database: rc.db,
    },
    true,
  ).connect())
}

export class Redis {
  constructor(opts, exit) {
    Bot.makeLog(
      "info",
      `正在连接 ${logger.cyan(`redis://${opts.socket.host}:${opts.socket.port}/${opts.database}`)}`,
      "Redis",
    )
    this.opts = opts
    this.redis = /** @type {AugmentedRedisClient} */ (createClient(opts))
    this.redis.class = this
    this.exit = exit
  }

  async connect(force) {
    if (this.lock && !force) return
    this.lock = true

    try {
      await this.redis.connect()
    } catch (err) {
      await this.redis.disconnect().catch(err => Bot.makeLog("error", err, "Redis"))
      this.err = err
      if (!force) return this.start()
      return false
    }

    for (let i = 0; i < 15; i++) {
      try {
        const id = Date.now().toString(36)
        if ((await this.redis.ping(id)) === id) break
      } catch (err) {
        Bot.makeLog("error", err, "Redis")
      }
      await Bot.sleep(1000)
    }

    this.lock = false
    return this.redis.once("error", this.onerror)
  }

  async start() {
    if (this.opts.socket.host !== "127.0.0.1") {
      Bot.makeLog("error", ["连接错误，请确认连接地址正确", this.err], "Redis")
      if (this.exit) await Bot.exit()
      return false
    }

    const cmd = [cfg.redis.path, "--port", this.opts.socket.port, ...(await this.aarch64())]
    Bot.makeLog("info", ["正在启动", logger.cyan(cmd.join(" "))], "Redis")
    const redisProcess = /** @type {RedisProcess} */ (
      spawn(cmd[0], cmd.slice(1))
        .on("error", err => {
          Bot.makeLog("error", ["启动错误", err], "Redis")
          redisProcess.exit = true
        })
        .on("exit", () => (redisProcess.exit = true))
    )
    redisProcess.stdout.on("data", data => Bot.makeLog("info", Bot.String(data).trim(), "Redis"))
    redisProcess.stderr.on("data", data => Bot.makeLog("error", Bot.String(data).trim(), "Redis"))
    this.redis.process = redisProcess

    for (let i = 0; i < 15; i++) {
      await Bot.sleep(1000)
      if (redisProcess.exit) break
      const ret = await this.connect(true)
      if (ret) return ret
    }

    Bot.makeLog("error", ["连接错误", this.err], "Redis")
    redisProcess.kill()
    if (this.exit) await Bot.exit()
    return false
  }

  onerror = async err => {
    Bot.makeLog("error", err, "Redis")
    await this.redis.disconnect().catch(err => Bot.makeLog("error", err, "Redis"))
    if (this.redis.process) this.redis.process.kill()
    return this.connect()
  }

  async aarch64() {
    if (process.platform === "win32" || process.arch !== "arm64") return []
    /** 判断redis版本 */
    let v = await Bot.exec(`"${cfg.redis.path}" -v`)
    if (v.stdout?.match) {
      v = v.stdout.match(/v=(\d)./)
      /** 忽略arm警告 */
      if (v && v[1] >= 6) return ["--ignore-warnings", "ARM64-COW-BUG"]
    }
    return []
  }
}
