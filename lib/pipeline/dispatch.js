import lodash from "lodash"

/**
 * 流水线阶段用到的纯函数集合。
 *
 * # 为什么是独立实现而不是调用 `PluginsLoader` 的同名方法
 *
 * 阶段 2 的第 3 步要做「影子运行对比」：同一条事件分别走旧 `deal()` 与新流水线，
 * 逐决策点比较。**如果两边共享同一份实现，对比就毫无意义**——它只能证明"代码相同"，
 * 不能证明"行为相同"。所以这里是照着 `lib/plugins/loader.js` 翻译的独立实现。
 *
 * 阶段 2 第 5 步切换完成后，`loader.js` 里对应的旧实现会被删除，这份成为唯一实现。
 *
 * 每个函数都对应 loader 里的一个方法，语义要求**逐字等价**：
 * 改动这里的任何一处都等于改动消息处理语义，必须同步更新测试与 `02-pipeline.md`。
 */

/** 事件类型 → 参与比较的字段名（与 `PluginsLoader.eventMap` 一致） */
const EVENT_MAP = {
  message: ["post_type", "message_type", "sub_type"],
  notice: ["post_type", "notice_type", "sub_type"],
  request: ["post_type", "request_type", "sub_type"],
}

/**
 * 事件声明解析结果的缓存。
 *
 * 以**声明所在的对象**为键（而不是声明字符串）：字符串不能做 WeakMap 的键，
 * 且这样与 `PluginsLoader.eventCache` 的行为一致——同一插件对象只解析一次。
 *
 * @type {WeakMap<object, { source: string, parts: string[] }>}
 */
const eventCache = new WeakMap()

/**
 * 判断事件是否命中形如 `message.group.normal` 的声明，支持用 `*` 通配某一段。
 *
 * 对应 `PluginsLoader.filtEvent()`。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @param {{ event?: unknown }} holder 带 `event` 声明的对象（插件实例或 rule）
 * @returns {boolean} 是否命中
 */
export function matchesEvent(event, holder) {
  if (!holder?.event) return false

  let cache = eventCache.get(holder)
  if (!cache || cache.source !== holder.event) {
    cache = { source: String(holder.event), parts: String(holder.event).split(".") }
    eventCache.set(holder, cache)
  }

  const map = EVENT_MAP[/** @type {string} */ (event.post_type)] || []
  const mapped = cache.parts.map((value, i) => (value === "*" ? value : event[map[i]]))
  return cache.source === mapped.join(".")
}

/**
 * 文本归一化（全角符号、前导 `/` 转 `#`）。
 *
 * 对应 `PluginsLoader.dealText()`。
 *
 * @param {string} [text] 原始文本
 * @param {boolean} [slashToHash] `config/bot.yaml` 的 `/→#`，缺省按 true 处理（与默认配置一致）
 * @returns {string} 归一化后的文本
 */
export function normalizeText(text = "", slashToHash = true) {
  if (slashToHash) text = text.replace(/^\s*\/\s*/, "#")
  return text
    .replace(/^\s*[＃井]\s*/, "#")
    .replace(/^\s*[＊※]\s*/, "*")
    .trim()
}

/**
 * 权限判定。**不发送任何消息**——需要提示时把文本返回给调用方。
 *
 * 对应 `PluginsLoader.filtPermission()`，其中直接 `e.reply(...)` 的部分被改成返回值，
 * 便于单测断言（行为上等价：调用方拿到 `message` 后立即发送）。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @param {{ permission?: unknown }} rule 命令规则
 * @returns {{ ok: boolean, message?: string }} 判定结果
 */
export function checkPermission(event, rule) {
  if (!rule?.permission || event.isMaster) return { ok: true }

  if (rule.permission === "master") return { ok: false, message: "暂无权限，只有主人才能操作" }

  if (event.isGroup) {
    const member = /** @type {{ is_owner?: boolean, is_admin?: boolean }} */ (event.member ?? {})
    if (rule.permission === "owner" && !member.is_owner)
      return { ok: false, message: "暂无权限，只有群主才能操作" }
    if (rule.permission === "admin" && !member.is_owner && !member.is_admin)
      return { ok: false, message: "暂无权限，只有管理员才能操作" }
  }

  return { ok: true }
}

/**
 * 判断某个插件在指定群配置下是否启用。
 *
 * 对应 `PluginsLoader.checkDisable()`。注意 `disable` 优先于 `enable`。
 *
 * @param {string} pluginName 插件名（对应配置里的功能名称）
 * @param {{ enable?: string[], disable?: string[] }} groupCfg 群配置
 * @returns {boolean} 是否启用
 */
export function isPluginEnabled(pluginName, groupCfg) {
  if (groupCfg.disable?.length && groupCfg.disable.includes(pluginName)) return false
  if (groupCfg.enable?.length && !groupCfg.enable.includes(pluginName)) return false
  return true
}

/**
 * 判断是否应当继续按"只关注主动 at"处理。
 *
 * 对应 `PluginsLoader.onlyReplyAt()`。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @param {{ onlyReplyAt?: number, botAlias?: unknown }} groupCfg 群配置
 * @returns {boolean} 是否继续处理
 */
export function shouldReplyOnlyAt(event, groupCfg) {
  if (!event.message || event.isPrivate) return true
  if (groupCfg.onlyReplyAt === 0 || !groupCfg.botAlias) return true
  if (groupCfg.onlyReplyAt === 2 && event.isMaster) return true
  if (event.atBot) return true
  if (event.hasAlias) return true
  return false
}

/**
 * 截断文本用于日志，对应 loader 里 `lodash.truncate(..., { length: 100 })` 的用法。
 *
 * @param {unknown} value 待截断的值（非字符串会先转字符串）
 * @returns {string} 截断后的文本
 */
export function truncateForLog(value) {
  return lodash.truncate(value === undefined || value === null ? "" : String(value), {
    length: 100,
  })
}
