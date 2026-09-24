import fs from "node:fs/promises"
import lodash from "lodash"
import cfg from "../config/config.js"
import { persistKey } from "../config/redis-keys.js"
import plugin from "./plugin.js"
import schedule from "node-schedule"
import { segment } from "oicq"
import chokidar from "chokidar"
import moment from "moment"
import path from "node:path"
import Handler from "./handler.js"
import { dirNameFromKey, readMetadata } from "./metadata.js"
import { checkHostVersion } from "./version.js"
import { loadPluginConfig } from "./plugin-config.js"
import { checkHandlers, normalizeRules } from "./rule.js"

/** 全局变量 plugin */
global.plugin = plugin
global.segment = segment

/**
 * 加载插件
 */
class PluginsLoader {
  priority = []
  handler = {}
  task = []
  dir = "plugins"

  /** 命令冷却cd */
  groupCD = {}
  singleCD = {}

  /** 插件监听 */
  watcher = {}
  taskMap = new Map()
  pluginCountMap = new Map()
  /** 已上报过目录级告警（元数据/配置）的目录，避免同一目录下多个插件类重复刷屏 */
  reportedDirs = new Set()
  /** 已上报过「版本不满足被拒」的文件，避免一个文件导出多个插件类时重复刷屏 */
  rejectedFiles = new Set()
  eventCache = new WeakMap()
  eventMap = {
    message: ["post_type", "message_type", "sub_type"],
    notice: ["post_type", "notice_type", "sub_type"],
    request: ["post_type", "request_type", "sub_type"],
  }

  msgThrottle = {}

  /** 星铁命令前缀 */
  srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
  /** 绝区零前缀 */
  zzzReg = /^#?(%|％|绝区零|绝区)+/

  async getPlugins() {
    const files = await fs.readdir(this.dir, { withFileTypes: true })
    const ret = []
    for (const val of files) {
      if (val.isFile()) continue
      const tmp = {
        name: val.name,
        path: `../../${this.dir}/${val.name}`,
      }

      if (await Bot.fsStat(`${this.dir}/${val.name}/index.js`)) {
        tmp.path = `${tmp.path}/index.js`
        ret.push(tmp)
        continue
      }

      const apps = await fs.readdir(`${this.dir}/${val.name}`, { withFileTypes: true })
      for (const app of apps) {
        if (!app.isFile()) continue
        if (!app.name.endsWith(".js")) continue
        ret.push({
          name: `${tmp.name}/${app.name}`,
          path: `${tmp.path}/${app.name}`,
        })
        /** 监听热更新 */
        this.watch(val.name, app.name)
      }
    }
    return ret
  }

  /**
   * 监听事件加载
   * @param isRefresh 是否刷新
   */
  async load(isRefresh = false) {
    if (isRefresh) {
      this.reportedDirs.clear()
      this.rejectedFiles.clear()
      const keys = new Set([
        ...this.priority.map(i => i.key),
        ...this.taskMap.keys(),
        ...this.pluginCountMap.keys(),
      ])
      for (const key of keys) await this.unloadPlugin(key)
    }
    if (this.priority.length) return

    Bot.makeLog("info", "-----------", "Plugin")
    Bot.makeLog("info", "加载插件中...", "Plugin")

    const files = await this.getPlugins()
    this.pluginCount = 0
    const packageErr = []

    await Promise.allSettled(
      files.map(async file => {
        if (
          (await Bot.sleep(
            cfg.bot.plugin_load_timeout * 1000,
            this.importPlugin(file, packageErr),
          )) === Bot.sleepTimeout
        )
          Bot.makeLog("error", `插件加载超时 ${logger.red(file.name)}`, "Plugin")
      }),
    )

    this.packageTips(packageErr)
    this.createTask()

    Bot.makeLog("info", `加载定时任务[${this.task.length}个]`, "Plugin")
    Bot.makeLog("info", `加载插件[${this.pluginCount}个]`, "Plugin")

    /** 优先级排序 */
    this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
  }

  load_time = {}
  async importPlugin(file, packageErr) {
    const start_time = Date.now()
    let success = true
    this.pluginCountMap.set(file.name, 0)
    try {
      const module = await import(file.path)
      const app = module.apps ? { ...module.apps } : module
      const pluginArray = []
      lodash.forEach(app, p => pluginArray.push(this.loadPlugin(file, p)))
      for (const i of await Promise.allSettled(pluginArray))
        if (i?.status && i.status !== "fulfilled") {
          success = false
          Bot.makeLog("error", [`插件加载错误 ${logger.red(file.name)}`, i], "Plugin")
        }
    } catch (error) {
      success = false
      if (packageErr && error.stack.includes("Cannot find package")) {
        packageErr.push({ error, file })
      } else {
        Bot.makeLog("error", [`插件加载错误 ${logger.red(file.name)}`, error], "Plugin")
      }
    }
    this.load_time[file.name] = Date.now() - start_time
    return success
  }

  async loadPlugin(file, p) {
    if (!p?.prototype) return

    const dirName = dirNameFromKey(file.name)

    /** 插件元数据（目录级，带缓存），见 docs/refactor/01-plugin-contract.md */
    const { metadata, errors, warnings } = await readMetadata(dirName)

    /**
     * 宿主版本要求：这是引入元数据的核心目的，不满足即拒绝加载。
     * 逃生开关：config/bot.yaml 的 strict_plugin_version: false
     */
    const version = checkHostVersion(metadata.yunzai, cfg.package.version)
    if (!version.ok && cfg.bot.strict_plugin_version !== false) {
      // 一个文件可能导出多个插件类，拒绝原因完全相同，因此按文件名去重
      if (!this.rejectedFiles.has(file.name)) {
        this.rejectedFiles.add(file.name)
        Bot.makeLog(
          "error",
          [
            `${logger.red(file.name)} 未加载：${version.reason}`,
            version.invalid
              ? "请修正 plugin.json 的 yunzai 字段"
              : "可在 config/bot.yaml 设置 strict_plugin_version: false 强制加载",
          ],
          "Plugin",
        )
      }
      return
    }
    if (!version.ok)
      Bot.makeLog(
        "warn",
        `${file.name} 不满足宿主版本要求，已强制加载：${version.reason}`,
        "Plugin",
      )
    else if (version.reason)
      Bot.makeLog("debug", `${file.name} 版本校验跳过：${version.reason}`, "Plugin")

    this.pluginCount++
    this.pluginCountMap.set(file.name, (this.pluginCountMap.get(file.name) ?? 0) + 1)

    /** 插件配置（目录级，带缓存）：只读注入，不接管旧插件的配置读取路径 */
    const { config, problems } = await loadPluginConfig(dirName, metadata)

    /**
     * 契约挂在**类**上而不是实例上：每条消息都会用 `new i.class(e)` 新建实例，
     * 挂实例只有加载期那一个实例能拿到，插件就用不上配置了。
     */
    p.contract = { metadata, config, dirName, source: metadata.source }

    /** 初始化、定时任务实例 */
    const init = new p()
    Bot.makeLog("debug", `加载插件 [${file.name}][${init.name}]`, "Plugin")
    /** 执行初始化，返回 return 则跳过加载 */
    if (init.init && (await init.init()) === "return") return
    /** 设置定时任务 */
    this.collectTask(init.task, init.name, file.name)
    /** 处理消息实例 */
    const plugin = new p()

    /** 规则归一化：就地编译正则（与改造前一致）+ 补校验告警 */
    const { warnings: ruleWarnings } = normalizeRules(plugin)

    const notes = [...ruleWarnings, ...checkHandlers(plugin)]
    /** 目录级告警（元数据/配置）只报一次，否则一个目录下 9 个插件会刷 9 遍 */
    if (!this.reportedDirs.has(dirName)) {
      this.reportedDirs.add(dirName)
      notes.unshift(...errors, ...warnings, ...problems)
    }
    for (const note of notes) Bot.makeLog("warn", `${logger.yellow(file.name)} ${note}`, "Plugin")

    const namespace = plugin.namespace || file.name
    this.priority.push({
      plugin,
      class: p,
      key: file.name,
      name: plugin.name,
      priority: plugin.priority,
      namespace,
    })
    this.registerHandlers(plugin, namespace)
  }

  registerHandlers(plugin, namespace = plugin.namespace) {
    if (!plugin.handler) return
    lodash.forEach(plugin.handler, ({ fn, key, priority }) => {
      Handler.add({
        ns: namespace,
        key,
        self: plugin,
        priority: priority ?? plugin.priority,
        fn: plugin[fn],
      })
    })
  }

  packageTips(packageErr) {
    if (!packageErr.length) return
    Bot.makeLog("error", "--------- 插件加载错误 ---------", "Plugin")
    for (const i of packageErr) {
      const pack = i.error.stack.match(/'(.+?)'/g)[0].replace(/'/g, "")
      Bot.makeLog("error", `${logger.cyan(i.file.name)} 缺少依赖 ${logger.red(pack)}`, "Plugin")
    }
    Bot.makeLog("error", `安装插件后请 ${logger.red("pnpm i")} 安装依赖`, "Plugin")
    Bot.makeLog("error", `仍报错${logger.red("进入插件目录")} pnpm add 依赖`, "Plugin")
    Bot.makeLog("error", "--------------------------------", "Plugin")
  }

  /** 过滤事件 */
  filtEvent(e, v) {
    if (!v.event) return false
    let cache = this.eventCache.get(v)
    if (!cache || cache.source !== v.event) {
      cache = { source: v.event, event: v.event.split(".") }
      this.eventCache.set(v, cache)
    }

    const eventMap = this.eventMap[e.post_type] || []
    const mappedEvent = cache.event.map((value, i) => (value === "*" ? value : e[eventMap[i]]))
    return v.event === mappedEvent.join(".")
  }

  /** 判断权限 */
  filtPermission(e, v) {
    if (!v.permission || e.isMaster) return true

    if (v.permission === "master") {
      e.reply("暂无权限，只有主人才能操作")
      return false
    }

    if (e.isGroup) {
      if (v.permission === "owner" && !e.member.is_owner) {
        e.reply("暂无权限，只有群主才能操作")
        return false
      }
      if (v.permission === "admin" && !e.member.is_owner && !e.member.is_admin) {
        e.reply("暂无权限，只有管理员才能操作")
        return false
      }
    }

    return true
  }

  dealText(text = "") {
    if (cfg.bot["/→#"]) text = text.replace(/^\s*\/\s*/, "#")
    return text
      .replace(/^\s*[＃井]\s*/, "#")
      .replace(/^\s*[＊※]\s*/, "*")
      .trim()
  }

  /** 处理回复,捕获发送失败异常 */
  reply(e) {
    if (!e.reply?.bind) return
    const reply = e.reply.bind(e)

    /**
     * @param {string | any[]} msg 发送的消息：字符串或消息段数组
     *   （下面会在数组上补 at / quote，所以不能按默认值推断成 string）
     * @param {boolean} [quote] 是否引用回复
     * - `data.recallMsg` 是否撤回消息，0-120秒，0不撤回
     * - `data.at` 是否提及用户
     * （第三个参数 `data` 的点号名同样改用描述列表，理由见
     * docs/refactor/baseline/static-analysis.md §3.4。原本这里指向已删除的
     * `dealEvent()` 的同类注释，阶段 2 第 5 步删掉那段代码后改指文档。）
     */
    e.reply = async (msg = "", quote = false, data = {}) => {
      if (!msg) return false

      let { recallMsg = 0, at = "" } = data

      if (at && e.isGroup) {
        if (at === true) at = e.user_id
        if (Array.isArray(msg)) msg.unshift(segment.at(at), "\n")
        else msg = [segment.at(at), "\n", msg]
      }

      if (quote && e.message_id) {
        if (Array.isArray(msg)) msg.unshift(segment.reply(e.message_id))
        else msg = [segment.reply(e.message_id), msg]
      }

      let res
      try {
        res = await reply(msg)
      } catch (err) {
        Bot.makeLog("error", ["发送消息错误", msg, err], e.self_id)
        res = { error: [err] }
      }

      if (recallMsg > 0 && res?.message_id) {
        if (e.group?.recallMsg)
          setTimeout(() => {
            e.group.recallMsg(res.message_id)
            if (e.message_id) e.group.recallMsg(e.message_id)
          }, recallMsg * 1000)
        else if (e.friend?.recallMsg)
          setTimeout(() => {
            e.friend.recallMsg(res.message_id)
            if (e.message_id) e.friend.recallMsg(e.message_id)
          }, recallMsg * 1000)
      }

      this.count(e, "send", msg)
      return res
    }
  }

  async count(e, type, msg) {
    const count = new Map([[`${type}:msg`, 1]])
    if (cfg.bot.msg_type_count)
      for (const i of Array.isArray(msg) ? msg : [msg]) {
        const key = `${type}:${i?.type || "text"}`
        count.set(key, (count.get(key) || 0) + 1)
      }
    await this.saveCounts(e, count)
  }

  async saveCount(e, type) {
    await this.saveCounts(e, new Map([[type, 1]]))
  }

  async saveCounts(e, count) {
    const key = []

    const now = moment()
    const day = now.format("YYYY:MM:DD")
    const month = now.format("YYYY:MM")
    const year = now.format("YYYY")
    for (const i of [day, month, year, "total"]) {
      key.push(`total:${i}`)
      if (e.self_id) key.push(`bot:${e.self_id}:${i}`)
      if (e.user_id) key.push(`user:${e.user_id}:${i}`)
      if (e.group_id) key.push(`group:${e.group_id}:${i}`)
    }

    const multi = redis.multi()
    for (const [type, value] of count)
      for (const i of key) multi.incrBy(persistKey("count", type, i), value)
    await multi.exec()
  }

  /** 收集定时任务 */
  collectTask(task, name, key) {
    const tasks = key && (this.taskMap.get(key) ?? new Set())
    if (key) this.taskMap.set(key, tasks)
    for (const i of Array.isArray(task) ? task : [task])
      if (i.cron && i.fnc) {
        i.name ??= name
        this.task.push(i)
        tasks?.add(i)
      }
  }

  async startTask(name, i) {
    try {
      const start_time = Date.now()
      Bot.makeLog(
        i.log === false ? "debug" : "mark",
        `${name}${logger.yellow("[开始处理]")}`,
        false,
      )
      await i.fnc()
      Bot.makeLog(
        i.log === false ? "debug" : "mark",
        `${name}${logger.green(`[完成${Bot.getTimeDiff(start_time)}]`)}`,
        false,
      )
    } catch (err) {
      Bot.makeLog("error", [name, err], false)
    }
  }

  /** 创建定时任务 */
  createTask() {
    const created = new Set()
    for (const i of this.task) {
      if (i.job?.cancel) i.job.cancel()
      const name = `${logger.blue(`[${i.name}(${i.cron})]`)}`
      if (created.has(name)) {
        Bot.makeLog("warn", `重复定时任务 ${name} 已跳过`, "Task")
        continue
      }
      created.add(name)
      Bot.makeLog("debug", `加载定时任务 ${name}`, "Task")
      i.job = schedule.scheduleJob(
        i.cron.split(/\s+/).slice(0, 6).join(" "),
        this.startTask.bind(this, name, i),
      )
    }
  }

  /** 判断黑白名单 */
  checkBlack(e) {
    const other = cfg.getOther()

    /** 黑名单用户 */
    if (other.blackUser?.length && other.blackUser.includes(Number(e.user_id) || String(e.user_id)))
      return false
    /** 白名单用户 */
    if (
      other.whiteUser?.length &&
      !other.whiteUser.includes(Number(e.user_id) || String(e.user_id))
    )
      return false

    if (e.group_id) {
      /** 黑名单群 */
      if (
        other.blackGroup?.length &&
        other.blackGroup.includes(Number(e.group_id) || String(e.group_id))
      )
        return false
      /** 白名单群 */
      if (
        other.whiteGroup?.length &&
        !other.whiteGroup.includes(Number(e.group_id) || String(e.group_id))
      )
        return false
    }

    return true
  }

  /** 判断是否启用功能 */
  checkDisable(p, groupCfg) {
    groupCfg ||= cfg.getGroup(p.e.self_id, p.e.group_id)
    if (groupCfg.disable?.length && groupCfg.disable.includes(p.name)) return false
    if (groupCfg.enable?.length && !groupCfg.enable.includes(p.name)) return false
    return true
  }

  async unloadPlugin(key, closeWatcher = false) {
    const entries = this.priority.filter(i => i.key === key)
    const namespaces = new Set(entries.map(i => i.namespace || i.plugin.namespace || key))
    for (const ns of namespaces) Handler.del(ns)

    const tasks = this.taskMap.get(key)
    if (tasks) {
      for (const i of tasks) i.job?.cancel?.()
      this.task = this.task.filter(i => !tasks.has(i))
      this.taskMap.delete(key)
    }

    this.priority = this.priority.filter(i => i.key !== key)
    const pluginCount = this.pluginCountMap.get(key) ?? entries.length
    if (typeof this.pluginCount === "number")
      this.pluginCount = Math.max(0, this.pluginCount - pluginCount)
    this.pluginCountMap.delete(key)
    delete this.load_time[key]

    if (closeWatcher) {
      const watcherKey = key.replace("/", ".")
      const watcher = this.watcher[watcherKey]
      if (watcher) {
        watcher.changeHandler?.cancel?.()
        watcher.unlinkHandler?.cancel?.()
        await Promise.resolve(watcher.close?.()).catch(() => {})
        delete this.watcher[watcherKey]
      }
    }
  }

  async changePlugin(key) {
    const oldPriority = this.priority.filter(i => i.key === key)
    const oldTasks = this.taskMap.get(key)
    const oldPluginFileCount = this.pluginCountMap.get(key)
    const oldLoadTime = this.load_time[key]
    const oldPluginCount = this.pluginCount
    try {
      await this.unloadPlugin(key)
      const success = await this.importPlugin({
        name: key,
        path: `../../${this.dir}/${key}?${moment().format("x")}`,
      })
      if (!success) {
        await this.unloadPlugin(key)
        this.priority.push(...oldPriority)
        if (oldTasks) {
          const tasks = [...oldTasks]
          this.task.push(...tasks)
          this.taskMap.set(key, new Set(tasks))
        }
        if (oldLoadTime !== undefined) this.load_time[key] = oldLoadTime
        this.pluginCount = oldPluginCount
        if (oldPluginFileCount !== undefined) this.pluginCountMap.set(key, oldPluginFileCount)
        for (const i of oldPriority) this.registerHandlers(i.plugin, i.namespace || key)
      }
      this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
      this.createTask()
    } catch (err) {
      Bot.makeLog("error", [`插件加载错误 ${logger.red(key)}`, err], "Plugin")
    }
  }

  /** 监听热更新 */
  watch(dirName, appName) {
    this.watchDir(dirName)
    if (this.watcher[`${dirName}.${appName}`]) return

    const file = `./${this.dir}/${dirName}/${appName}`
    const watcher = chokidar.watch(file)
    const key = `${dirName}/${appName}`

    /** 监听修改 */
    const changeHandler = lodash.debounce(() => {
      Bot.makeLog("mark", `[修改插件][${dirName}][${appName}]`, "Plugin")
      this.changePlugin(key)
    }, 5000)
    watcher.on("change", changeHandler)

    /** 监听删除 */
    const unlinkHandler = lodash.debounce(async () => {
      Bot.makeLog("mark", `[卸载插件][${dirName}][${appName}]`, "Plugin")
      await this.unloadPlugin(key, true)
    }, 5000)
    watcher.on("unlink", unlinkHandler)
    // 把两个 handler 挂在 watcher 上，卸载时用来 cancel 掉 debounce
    const watched = /** @type {FSWatcherWithHandlers} */ (watcher)
    watched.changeHandler = changeHandler
    watched.unlinkHandler = unlinkHandler
    this.watcher[`${dirName}.${appName}`] = watcher
  }

  /** 监听文件夹更新 */
  watchDir(dirName) {
    if (this.watcher[dirName]) return
    const watcher = chokidar.watch(`./${this.dir}/${dirName}/`)
    /** 热更新 */
    Bot.once("online", () => {
      /** 新增文件 */
      watcher.on(
        "add",
        lodash.debounce(async PluPath => {
          const appName = path.basename(PluPath)
          if (!appName.endsWith(".js")) return
          Bot.makeLog("mark", `[新增插件][${dirName}][${appName}]`, "Plugin")
          const key = `${dirName}/${appName}`
          await this.importPlugin({
            name: key,
            path: `../../${this.dir}/${key}?${moment().format("X")}`,
          })
          /** 优先级排序 */
          this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
          this.createTask()
          this.watch(dirName, appName)
        }, 5000),
      )
    })
    this.watcher[dirName] = watcher
  }
}
export default new PluginsLoader()

// 具名导出类本身：单测与影子运行需要一个干净的独立实例，
// 而 default 是**单例**——直接用它会被上一个用例的限流表污染
export { PluginsLoader }

/**
 * chokidar 的 `FSWatcher` + 本仓挂上去的两个 handler 引用。
 *
 * 卸载插件时要按引用解绑（`cancel()` 掉 debounce），所以得把 handler 存下来。
 * 字段写成必选：属性全可选的对象类型会被 TS 当弱类型从交叉里约简掉，
 * 那样 `.changeHandler` 依旧报错（同 lib/config/redis.js 的 RedisProcess）。
 *
 * @typedef {import("chokidar").FSWatcher & {
 *   changeHandler: { cancel?: () => void },
 *   unlinkHandler: { cancel?: () => void },
 * }} FSWatcherWithHandlers
 */
