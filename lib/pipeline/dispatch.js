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
 * 事件上的 `group` / `friend`：既有数据字段也有方法。
 * 事件对象是动态的（字段类型都是 `unknown`），这里集中收窄一次。
 *
 * @typedef {object} ChatTarget
 * @property {(id: unknown) => Promise<unknown>} [getMsg]
 * @property {(id: unknown) => Promise<unknown>} [recallMsg]
 * @property {(msg: unknown) => Promise<unknown>} [sendMsg]
 */

/**
 * 把 `event.group` / `event.friend` 收窄成 `ChatTarget`（缺失时给空对象）。
 *
 * @param {unknown} target 待收窄的值
 * @returns {ChatTarget} 收窄后的对象
 */
export function asChatTarget(target) {
  return /** @type {ChatTarget} */ (target ?? {})
}

/**
 * 实例化插件类并注入 `e`。
 *
 * 对应 loader 里反复出现的 `Object.assign(new i.class(e), { e })`。
 * 抽成函数只是为了把类型收窄集中在一处——插件类来自动态 `import`，
 * 类型上只能当作"可按下标取字段的容器"。
 *
 * @param {import("./context.js").PluginEntry} entry 调度条目
 * @param {Record<string, unknown>} event 事件对象
 * @returns {Record<string, unknown>} 插件实例
 */
export function instantiate(entry, event) {
  return Object.assign(new entry.class(event), { e: event })
}

/**
 * 把插件实例视为"可调用的方法字典"。
 *
 * 仅用于消除 `Record<string, unknown>` 的"不可调用"类型错误，运行时不产生任何操作。
 * **不代替存在性检查**：调用方仍需自己判断方法是否存在——缺方法时抛 TypeError
 * 正是旧实现的行为，不要用可选调用把它变成静默跳过。
 *
 * @param {Record<string, unknown>} instance 插件实例
 * @returns {Record<string, (...args: unknown[]) => Promise<unknown>>} 同一对象
 */
export function callables(instance) {
  return /** @type {Record<string, (...args: unknown[]) => Promise<unknown>>} */ (instance)
}

/**
 * 取事件上的 `reply` 并视为可调用。
 *
 * 与 `callables` 同理，只做类型收窄。在流水线里调用它拿到的**是 `PreProcessStage`
 * 包装后的 `reply`**（那一步在前），因此注入 `at` / `quote`、发送计数等行为都在。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @returns {(msg: unknown, quote?: boolean, data?: object) => Promise<unknown>} 发送函数
 */
export function replyOf(event) {
  return /** @type {(msg: unknown, quote?: boolean, data?: object) => Promise<unknown>} */ (
    event.reply
  )
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
 * 名单匹配（黑白名单用户 / 群）。
 *
 * 对应 loader 里反复出现的 `list.includes(Number(e.user_id) || String(e.user_id))`：
 * 名单里通常数字与字符串两种写法混用，因此用"数字优先、非数字回退字符串"的候选值比对。
 *
 * @param {unknown} list 名单（可能为 undefined / 空数组）
 * @param {unknown} value 待比对的值
 * @returns {boolean} 名单中是否包含该值
 */
export function matchId(list, value) {
  if (!Array.isArray(list) || list.length === 0) return false
  return list.includes(Number(value) || String(value))
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
