/**
 * `Bot.adapter` 数组的只读索引。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.4。
 *
 * # 为什么要在数组之外再建一份索引
 *
 * `Bot.adapter` 是**数组**，而且是 L0 冻结面：7 个内置适配器与第三方适配器都靠
 * `Bot.adapter.push(obj)` 注册，`push` 被改写成按 `path` 去重。这个契约不能动。
 * 但"按 id 找适配器"在数组上是线性扫描，而 `adapter_id` 是插件最常拿来判断的东西
 * （`if (e.adapter_id === "QQ")`）。索引让这类查询变成一次 `Map.get`。
 *
 * 索引由 `push` 驱动（见 `lib/bot.js`），**不自己扫数组**：数组可以被第三方直接
 * `Array.prototype.push.call()` 绕过——那种情况下索引与数组会不一致，
 * 这是已知且接受的取舍（绕过去的人本来就没走注册路径）。
 *
 * # 为什么是模块级单例
 *
 * `Bot` 本身就是单例，适配器只在启动时注册一次。测试里用 `resetAdapters()` 清空。
 */

/** `path` → 适配器对象（`path` 是 `push` 的去重键，因此天然唯一） */
const byPath = /** @type {Map<string, Record<string, unknown>>} */ (new Map())

/** `id` → 适配器对象（`id` 可能重复，见下方说明） */
const byId = /** @type {Map<string, Record<string, unknown>>} */ (new Map())

/**
 * 登记一个适配器。
 *
 * `id` 重复时**后登记的覆盖先登记的**：多个适配器可能共用同一个 `id`
 * （比如不同协议都由 `QQ` 账号驱动），此时 `id` 不足以定位唯一适配器，
 * 需要精确身份请用 `adapterByPath()`。
 *
 * @param {unknown} adapter `Bot.adapter.push()` 收到的对象
 * @returns {void}
 */
export function registerAdapter(adapter) {
  if (typeof adapter !== "object" || adapter === null) return
  const item = /** @type {Record<string, unknown>} */ (adapter)

  if (typeof item.path === "string") byPath.set(item.path, item)
  if (item.id !== undefined) byId.set(String(item.id), item)
}

/**
 * 按 `path` 取适配器。`path` 唯一，因此这个查询是可靠的。
 *
 * @param {unknown} path 适配器的 `path`
 * @returns {Record<string, unknown>|undefined} 适配器对象
 */
export function adapterByPath(path) {
  return byPath.get(String(path))
}

/**
 * 按 `id` 取适配器。`id` 可能重复（见 `registerAdapter`），返回最后登记的那个。
 *
 * @param {unknown} id 适配器的 `id`
 * @returns {Record<string, unknown>|undefined} 适配器对象
 */
export function adapterById(id) {
  return byId.get(String(id))
}

/**
 * 全部已登记适配器（按登记顺序）。
 *
 * @returns {Array<Record<string, unknown>>} 适配器列表
 */
export function adapters() {
  return [...byPath.values()]
}

/**
 * 清空索引。**只给测试用**——生产代码里适配器注册一次就不再变更。
 *
 * @returns {void}
 */
export function resetAdapters() {
  byPath.clear()
  byId.clear()
}
