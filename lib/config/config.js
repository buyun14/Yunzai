import YAML from "yaml"
import fs from "node:fs"
import chokidar from "chokidar"
import _ from "lodash"
import EventEmitter from "node:events"

/** 配置文件 */
class Cfg {
  constructor() {
    this.config = {}
    this.watcher = {}
    this.initCfg()

    if (this.getAllCfg("bot").file_watch === false) {
      class FSWatcher extends EventEmitter {
        constructor() {
          super()
        }
        on() {
          return this
        }
        addListener() {
          return this
        }
        start() {}
        close() {}
        ref() {
          return this
        }
        unref() {
          return this
        }
      }
      const watch = new FSWatcher()
      fs.watch = () => watch
      chokidar.watch = () => watch
      chokidar.FSWatcher = FSWatcher

      for (const i in this.watcher) {
        this.watcher[i].close()
        delete this.watcher[i]
      }
      this.watch = () => {}
    }

    return new Proxy(this, {
      get: (target, prop) => target[prop] ?? target.getAllCfg(String(prop)),
    })
  }

  /** 初始化配置 */
  initCfg() {
    const path = "config/config/"
    const pathDef = "config/default_config/"
    const filesDef = fs.readdirSync(pathDef)
    if (fs.existsSync(path)) {
      const files = fs.readdirSync(path)
      for (const i of filesDef)
        if (!files.includes(i)) fs.copyFileSync(`${pathDef}${i}`, `${path}${i}`)
    } else fs.cpSync(pathDef, path, { recursive: true })
  }

  /** 主人账号 */
  get masterQQ() {
    const other = this.getAllCfg("other")
    if (other.masterQQs) return other.masterQQs
    let masterQQ = other.masterQQ || []

    if (!Array.isArray(masterQQ)) masterQQ = [masterQQ]

    return (this.config["config.other"].masterQQs = masterQQ.map(i => Number(i) || i))
  }

  /** Bot账号:[主人帐号] */
  get master() {
    const other = this.getAllCfg("other")
    if (other.masters) return other.masters
    let master = other.master || []

    if (!Array.isArray(master)) master = [master]

    const masters = {}
    for (let i of master) {
      i = i.split(":")
      const bot_id = i.shift()
      const user_id = i.join(":")
      if (Array.isArray(masters[bot_id])) masters[bot_id].push(user_id)
      else masters[bot_id] = [user_id]
    }
    return (this.config["config.other"].masters = masters)
  }

  /** 机器人账号 */
  get uin() {
    return Object.keys(this.master)
  }
  get qq() {
    return this.uin
  }

  /** package.json */
  get package() {
    if (this._package) return this._package
    return (this._package = JSON.parse(fs.readFileSync("package.json", "utf8")))
  }

  /** 群配置 */
  getGroup(bot_id = "", group_id = "") {
    const config = this.getAllCfg("group")
    return {
      ...config.default,
      ...config[`${bot_id}:default`],
      ...config[group_id],
      ...config[`${bot_id}:${group_id}`],
    }
  }

  /** other配置 */
  getOther() {
    return this.getAllCfg("other")
  }

  /**
   * @param app  功能
   * @param name 配置文件名称
   */
  getdefSet(name) {
    return this.getYaml("default_config", name)
  }

  /** 用户配置 */
  getConfig(name) {
    return this.getYaml("config", name)
  }

  getAllCfg(name) {
    return {
      ...this.getdefSet(name),
      ...this.getConfig(name),
    }
  }

  /**
   * 获取配置yaml
   * @param type 默认配置-defSet，用户配置-config
   * @param name 名称
   */
  getYaml(type, name) {
    const key = `${type}.${name}`
    if (key in this.config) return this.config[key]
    const file = `config/${type}/${name}.yaml`

    try {
      this.config[key] = YAML.parse(fs.readFileSync(file, "utf8"))
    } catch (err) {
      Bot.makeLog("trace", ["读取配置文件", file, "错误", err], "Config")
      return (this.config[key] = undefined)
    }

    this.watch(file, name, type)
    return this.config[key]
  }

  /** 监听配置文件 */
  watch(file, name, type = "default_config") {
    const key = `${type}.${name}`
    if (this.watcher[key]) return

    this.watcher[key] = chokidar.watch(file)
    this.watcher[key].on(
      "change",
      _.debounce(() => {
        delete this.config[key]
        if (typeof Bot !== "object") return
        Bot.makeLog("mark", `[修改配置文件][${type}][${name}]`, "Config")
        if (`change_${name}` in this) this[`change_${name}`]()
      }, 5000),
    )
  }

  async change_bot() {
    /** 修改日志等级 */
    ;(await import("./log.js")).default()
  }
}

/**
 * 单个配置文件对应的对象（`config/config/<名字>.yaml`）。
 *
 * 用 `Record<string, any>` 而不是逐项声明是刻意的：这些值来自用户可手改的 YAML，
 * 逐项写类型会随配置项增减而腐化，换来的只是"配置项名打错能被发现"。
 * 本步的目标是让闸门能够归零，不是把配置系统重新设计一遍。
 *
 * @typedef {Record<string, any>} CfgGroup
 */

/**
 * Cfg 对外的完整类型：类自身的成员 + Proxy 动态转发的配置组。
 *
 * 为什么必须显式给出这 9 个属性：构造函数返回的是一个 Proxy，其 get 陷阱会把
 * **任何未命中已知成员的属性**转发给 `getAllCfg(属性名)`，也就是去读
 * `config/config/<属性名>.yaml`。所以 `cfg.bot` / `cfg.server` / `cfg.redis`
 * 在运行期完全合法，而类型系统无从得知——不给它们名字，每次访问都是 TS2339
 * （实测正好 100 处，占全部自有代码类型报错的 37%）。
 *
 * 这里用**交叉类型**而不是给 Cfg 加索引签名，两者差别很实际：
 * 索引签名（`Record<string, any>`）会把 `masterQQ` / `master` / `uin` 这些
 * **已显式声明**的成员一并退化成 any；而交叉类型只对"两边都有"的属性求交，
 * 所以已知成员的精确定义得以保留。
 *
 * 这 9 个名字与 `config/default_config/` 下的文件名一一对应，
 * 新增配置文件时这里要同步加一行。
 *
 * @typedef {object} CfgGroups
 * @property {CfgGroup} bot 机器人配置
 * @property {CfgGroup} db 数据库配置
 * @property {CfgGroup} group 群配置
 * @property {CfgGroup} milky Milky 适配器配置
 * @property {CfgGroup} other 其他配置
 * @property {CfgGroup} redis redis 配置
 * @property {CfgGroup} renderer 渲染配置
 * @property {CfgGroup} satori Satori 适配器配置
 * @property {CfgGroup} server HTTP 服务配置
 */

export default /** @type {Cfg & CfgGroups} */ (new Cfg())
