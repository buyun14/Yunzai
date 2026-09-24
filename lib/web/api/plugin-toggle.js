import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import cfg from "../../config/config.js"
import { backupBeforeWrite, writeAtomic } from "./config-write.js"
import { sendJSON } from "../security.js"

/**
 * `PUT /api/v1/plugins/{name}`：启用 / 停用一个插件。
 *
 * # 机制：写的是**群配置的 `default.disable`**，不是某个开关文件
 *
 * `lib/plugins/loader.js` 判定一个插件是否生效，看的是
 * `groupCfg.disable.includes(plugin.name)`，而 `groupCfg` 来自
 * `cfg.getGroup()`——它把 `group.yaml` 里的 `default` 与各群段叠起来。
 * 所以"全局停用某个插件"等于把它写进 `group.yaml` 的 `default.disable`
 * （`default` 在最外层，没有群段覆盖时对所有群生效）。
 *
 * 这也意味着停用是**按插件名**匹配的，而不是按文件路径——名字取自
 * `plugin` 构造函数里的 `name`，与 `/api/v1/plugins` 返回的 `name` 同一个。
 *
 * # 为什么写完能立刻生效（不需要重启）
 *
 * 每次消息进来都会重新算一遍生效范围，所以只要**缓存是新的**就立刻生效。
 * 而 `lib/config/config.js` 的 `getYaml()` 有解析缓存、`watch()` 的失效又是
 * 5 秒防抖——刚写完读到的还是旧值。因此这里显式调 `cfg.reload("group")`
 * 把缓存打掉，让下一次读取落到磁盘上。
 *
 * 这也回答了一个容易搞错的问题：**这个操作不写配置文件之外的任何东西**，
 * 所以没有"改了要重启"的代价。
 *
 * # 一个必须说清的边界
 *
 * 如果某个群**单独**配了 `enable: [这个插件]`，那条更具体的配置会盖过
 * `default.disable`（`getGroup` 的展开顺序决定）。界面拿不到"哪些群覆盖了它"，
 * 所以这里只如实回报"已经写进全局停用名单"，不去承诺"所有群都停了"。
 *
 * # 原子写与备份
 *
 * 与配置写入接口同一套做法：同目录临时文件 + `rename`，写前备份到
 * `config/backups/`。复用 `config-write.js` 的两个内部函数是刻意的——
 * 那是同一种写盘语义，没必要写两遍。
 */

/** 停用名单所在的文件与路径（`group.yaml` → `default.disable`） */
const GROUP_FILE = "group.yaml"

/**
 * 造插件启停处理器。
 *
 * @param {object} [deps] 依赖
 * @param {string} [deps.configDir] 用户配置目录
 * @param {string} [deps.backupDir] 写前备份目录
 * @param {object} [deps.cfgRef] 配置单例（测试可注入）
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => Promise<void>} 处理器
 */
export function createPluginToggleHandler({
  configDir = path.join("config", "config"),
  backupDir = path.join("config", "backups"),
  cfgRef = cfg,
} = {}) {
  return async (req, res, next) => {
    try {
      const name = String(req.params?.name ?? "").trim()
      if (!name) return sendJSON(res, 400, { code: "bad_request", message: "缺少插件名" })

      const body = /** @type {any} */ (req.body)
      if (!body || typeof body !== "object" || typeof body.enabled !== "boolean")
        return sendJSON(res, 400, {
          code: "bad_request",
          message: "请求体必须是 { enabled: true|false }",
        })

      const file = path.join(configDir, GROUP_FILE)
      let text = ""
      try {
        text = await fs.readFile(file, "utf8")
      } catch (err) {
        if (err?.code !== "ENOENT") throw err
      }

      const doc = YAML.parseDocument(text)
      if (doc.errors?.length)
        return sendJSON(res, 400, {
          code: "bad_request",
          message: `config/config/${GROUP_FILE} 当前不是合法 YAML，请先修好：${doc.errors[0].message}`,
        })

      // 现有的全局停用名单（`default.disable`）
      const current = /** @type {{ items?: Array<{ value: unknown }> }|undefined} */ (
        doc.getIn(["default", "disable"], true)
      )
      // 显式标注 items：`YAML.isSeq()` 对 TS 不构成收窄，item 的静态类型是 unknown
      const items = current?.items ?? []
      /** @type {string[]} */
      const before = YAML.isSeq(current)
        ? items.map(item => String(item.value)).filter(item => item.length > 0)
        : []
      let list = [...before]

      if (body.enabled) list = list.filter(item => item !== name)
      else if (!list.includes(name)) list.push(name)

      if (JSON.stringify(before) === JSON.stringify(list))
        return sendJSON(res, 200, {
          name,
          enabled: body.enabled,
          disableList: list,
          backup: null,
          restartRequired: false,
          note: "停用名单没有变化，未写盘",
        })

      // 名单为空时写回**空数组**而不是 null：读侧 `?.length` 对两者表现一致，
      // 但写回 null 会丢掉"这里本来有个列表"这个事实，用户下次打开 yaml 会以为坏了
      doc.setIn(["default", "disable"], list)

      let backup = null
      try {
        await fs.access(file)
        backup = await backupBeforeWrite(file, backupDir)
      } catch (err) {
        if (err?.code !== "ENOENT") throw err
      }
      await writeAtomic(file, doc.toString())

      // 打掉解析缓存，让下一次读取落到磁盘上（否则要等 watch 的 5 秒防抖）
      cfgRef.reload?.("group")

      sendJSON(res, 200, {
        name,
        enabled: body.enabled,
        disableList: list,
        backup,
        // 立刻生效：每次消息都会重算生效范围
        restartRequired: false,
        // 如实说明"更具体的群配置可能盖过这条"
        note: "已写入全局停用名单（group.yaml 的 default.disable）；单独给某个群配了 enable 的会盖过它",
      })
    } catch (err) {
      next(err)
    }
  }
}
