/**
 * 统一消息组件模型：类型枚举与「原始 segment → 组件」的判定。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.1。
 *
 * # 这个文件解决什么问题
 *
 * 现状是「消息形状」全靠隐式约定：`NormalizeStage.parseMessage()`（以及旧路径的
 * `PluginsLoader.dealEvent()`）直接对原始 segment 数组 `switch`，未识别的类型
 * **静默丢弃**。语音、视频、合并转发、戳一戳这些段到达插件时完全不可见，
 * 插件也没有任何办法知道"收到了一条语音"。
 *
 * 组件模型把这段逻辑显式化：先判定类型（未知的进 `Unknown` 而不是丢弃），
 * 再由 `legacy.js` 派生旧字段。新增的只有 `e.components` 这一个字段，
 * 旧字段的取值逐字不变。
 *
 * # 为什么组件要保留 `raw`
 *
 * 历史实现里 `e.file` 直接指向**原始 segment 对象**（`dealEvent` 的 `case "file"`），
 * 插件会把它整体转发出去（`e.reply(e.file)` 这类写法在生态里很常见）。
 * 若组件只保存自己复制的字段，`e.file` 就会变成另一个对象，属于行为变更。
 * 因此组件持有同一个 `raw` 引用，`legacy.js` 派生 `e.file` 时原样传出。
 *
 * # 类型的取舍
 *
 * 只登记该分册 §3.1 表里列出的那批名字，其余一律进 `Unknown`。这里刻意不做
 * "大而全"的类型表：每多一个名字就多一处需要与适配器对齐、需要维护的映射，
 * 而 `Unknown` 已经能无损读取 `raw`，信息不会丢。
 */

/** 组件类型。值即 `type` 字段的取值 */
export const ComponentType = Object.freeze({
  Plain: "plain",
  Image: "image",
  At: "at",
  Reply: "reply",
  File: "file",
  Json: "json",
  Xml: "xml",
  Record: "record",
  Video: "video",
  Face: "face",
  Poke: "poke",
  Forward: "forward",
  Node: "node",
  Music: "music",
  Share: "share",
  Location: "location",
  Contact: "contact",
  Dice: "dice",
  Rps: "rps",
  Shake: "shake",
  Unknown: "unknown",
})

/**
 * 适配器给的 segment 名 → 组件类型。
 *
 * 左边是各适配器实际发的名字（OneBot v11 / Satori / Milky 在这几个常见段上一致），
 * 右边是 `ComponentType`。
 */
const SEGMENT_TO_COMPONENT = Object.freeze({
  text: ComponentType.Plain,
  image: ComponentType.Image,
  at: ComponentType.At,
  reply: ComponentType.Reply,
  file: ComponentType.File,
  json: ComponentType.Json,
  xml: ComponentType.Xml,
  record: ComponentType.Record,
  video: ComponentType.Video,
  face: ComponentType.Face,
  poke: ComponentType.Poke,
  forward: ComponentType.Forward,
  node: ComponentType.Node,
  music: ComponentType.Music,
  share: ComponentType.Share,
  location: ComponentType.Location,
  contact: ComponentType.Contact,
  dice: ComponentType.Dice,
  rps: ComponentType.Rps,
  shake: ComponentType.Shake,
})

/**
 * 统一消息组件。
 *
 * - `type` 是映射后的组件类型（`ComponentType` 之一）
 * - `rawType` 是适配器给的原名，反向渲染时要用它（`render.js`）
 * - `raw` 是原始 segment 的**同一引用**，用于保持 `e.file` 之类的逐字一致
 * - 其余字段是原始 segment 的浅拷贝，便于按类型直接读：`c.text` / `c.url` /
 *   `c.qq` / `c.id` / `c.data` / `c.file` …
 *
 * 带上 `Record<string, unknown>` 是必须的：插进来的原始字段名无法预知，
 * 没有索引签名时 `c.text` 这类读法会直接报 TS2339。
 *
 * @typedef {Record<string, unknown> & {
 *   type: string,
 *   rawType: string,
 *   raw: unknown,
 * }} Component
 */

/**
 * 判定一个 segment 名对应的组件类型。
 *
 * @param {unknown} name 适配器给的 segment 名
 * @returns {string} 组件类型，未登记的一律 `Unknown`
 */
export function componentTypeOf(name) {
  if (typeof name !== "string") return ComponentType.Unknown
  return (
    SEGMENT_TO_COMPONENT[/** @type {keyof typeof SEGMENT_TO_COMPONENT} */ (name)] ??
    ComponentType.Unknown
  )
}

/**
 * 把单个原始 segment 转成组件。
 *
 * **不抛异常、不丢信息**：非对象（字符串、数字等）也照样包成一个组件，
 * 名字退化成 `typeof` 的结果。这是与现状最大的差别——现状是静默丢弃。
 *
 * @param {unknown} segment 原始 segment
 * @returns {Component} 组件
 */
export function parseSegment(segment) {
  const isObject = typeof segment === "object" && segment !== null
  const rawType = isObject ? /** @type {{ type?: unknown }} */ (segment).type : typeof segment

  return /** @type {Component} */ ({
    ...(isObject ? segment : {}),
    type: componentTypeOf(rawType),
    rawType: typeof rawType === "string" ? rawType : String(rawType),
    raw: segment,
  })
}

/**
 * 判断一个值是不是本模块产出的组件。
 *
 * 用于 `render.js`（阶段 4 v3）区分"组件数组"与"旧的 segment 数组"。
 *
 * @param {unknown} value 待判定值
 * @returns {boolean} 是否为组件
 */
export function isComponent(value) {
  if (typeof value !== "object" || value === null) return false
  const component = /** @type {Record<string, unknown>} */ (value)
  return typeof component.type === "string" && component.rawType !== undefined && "raw" in component
}
