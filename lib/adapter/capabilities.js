/**
 * 适配器能力表：组件 × 适配器的支持情况。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.4。
 *
 * # 它要解决的问题
 *
 * 现状下"这个适配器支不支持发语音"只能靠 `try/catch` 探测——`lib/bot.js` 的
 * `prepareEvent()` 会给 `friend` / `group` **无条件打上** `sendFile` /
 * `makeForwardMsg` 这些补丁（`??=`），于是"补丁存在"完全不代表"适配器支持"：
 * 调用之后的行为是未定义的。插件也因此无法在发送**之前**判断。
 *
 * 能力表把这件事变成可查询的数据。
 *
 * # 两条设计约束
 *
 * 1. **返回值有三态**：`true` / `false` / `undefined`。`undefined` 表示"未知"，
 *    消费方必须按"不要据此拦截"处理。未登记的适配器一律是 `undefined`——
 *    本仓只有 2 个适配器完成了声明，其余宁可说"不知道"也不猜。
 * 2. **只能用于降级提示，不能用于决定是否发送**（见分册 §7 的风险表）。
 *    声明写错时，最坏的后果应当是"多了一条提示"，而不是"功能静默消失"。
 *
 * # 内置表的值是怎么定的
 *
 * 逐条对着适配器源码看的，不是凭印象：
 *
 * | 能力 | OneBotv11（`QQ`） | Satori |
 * |---|---|---|
 * | `forward` | ✅ `makeForwardMsg` / `sendGroupForwardMsg` / `getForwardMsg` | ✅ `node` → `<message forward>` |
 * | `record` / `video` | ✅ 段直接透传给 OneBot API（`makeMsg` 不拦） | ✅ `record` / `video` → `<audio>` / `<video>` |
 * | `poke` | ❌ 没有对应的发 API | ❌ 没有对应元素 |
 * | `markdown` | ❌ 协议里没有 | ❌ 没有对应元素 |
 * | `json` | ✅ 段透传（OneBot 的 `json` 卡片） | ✅ 元素映射里有 `json` |
 *
 * `text` / `image` / `at` / `reply` 是所有适配器都有的通用能力，保留在表里是为了
 * 让消费方能"问任何东西"，但它们的值为 `true` 属于基线条目。
 */

/** 能力名（消费方可以问的键） */
export const CAPABILITY_KEYS = Object.freeze([
  "text",
  "image",
  "at",
  "reply",
  "record",
  "video",
  "forward",
  "poke",
  "json",
  "markdown",
])

/**
 * 宿主内置的能力表，按适配器的 `id` 索引。
 *
 * 适配器自己声明 `capabilities` 字段时以它为准（见 `capabilitiesOf`）。
 */
const BUILTIN = Object.freeze({
  /** OneBot v11（`plugins/adapter/OneBotv11.js`） */
  QQ: Object.freeze({
    text: true,
    image: true,
    at: true,
    reply: true,
    record: true,
    video: true,
    forward: true,
    poke: false,
    json: true,
    markdown: false,
  }),
  /** Satori（`plugins/adapter/Satori.js`） */
  Satori: Object.freeze({
    text: true,
    image: true,
    at: true,
    reply: true,
    record: true,
    video: true,
    forward: true,
    poke: false,
    json: true,
    markdown: false,
  }),
})

/**
 * 取一个适配器的能力表。
 *
 * 优先级：适配器显式声明的 `capabilities` → 内置表按 `id` 查 → `undefined`（未知）。
 *
 * @param {unknown} adapter 适配器对象，或适配器的 `id` 字符串
 * @returns {Record<string, boolean>|undefined} 能力表；未知时 `undefined`
 */
export function capabilitiesOf(adapter) {
  if (typeof adapter === "string") return BUILTIN[/** @type {keyof typeof BUILTIN} */ (adapter)]

  if (typeof adapter !== "object" || adapter === null) return undefined
  const item = /** @type {Record<string, unknown>} */ (adapter)

  const declared = item.capabilities
  if (typeof declared === "object" && declared !== null)
    return /** @type {Record<string, boolean>} */ (declared)

  if (item.id === undefined) return undefined
  return BUILTIN[/** @type {keyof typeof BUILTIN} */ (String(item.id))]
}

/**
 * 判断适配器是否具备某项能力。
 *
 * ⚠️ 返回 `undefined` 表示**未知**，不是"不支持"。消费方必须区分这两者：
 * 未知时应当照常发送（最多加一句降级提示），否则一次错误的声明就会让功能静默消失。
 *
 * @param {unknown} adapter 适配器对象，或适配器的 `id` 字符串
 * @param {string} capability 能力名（`CAPABILITY_KEYS` 之一）
 * @returns {boolean|undefined} `true` 支持 / `false` 不支持 / `undefined` 未知
 */
export function supports(adapter, capability) {
  const table = capabilitiesOf(adapter)
  if (!table) return undefined

  const value = table[capability]
  return typeof value === "boolean" ? value : undefined
}

/**
 * 定义了内置能力表的适配器 `id` 列表。
 *
 * 供测试与阶段 6 的 WebUI 用：只有这些 `id` 的适配器能给出确定的能力答案。
 *
 * @returns {string[]} 适配器 id
 */
export function builtinAdapterIds() {
  return Object.keys(BUILTIN)
}
