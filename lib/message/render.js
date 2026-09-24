/**
 * `Component[]` → 适配器可发送的 segment 数组。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.1 与 §3.2 的 v3。
 *
 * # 渲染策略：能原样送回就原样送回
 *
 * 组件是从真实 segment 解析出来的，`raw` 就是那个对象本身（见 `component.js`）。
 * 因此渲染的首要选择是**把 `raw` 原样返回**——这样往返一圈之后，适配器收到的
 * 还是它当初发出去的那个对象，逐字一致、引用相同，不存在"字段被重排/丢失"的风险。
 *
 * 只有手工构造的组件（没有 `raw`）才需要按 `rawType`（适配器的段名）反查并重建。
 *
 * # 为什么渲染层不碰能力表
 *
 * "能不能发"是能力表的事（`lib/adapter/capabilities.js` 的 `unsupportedComponents`）。
 * 这一层只负责"组件 ↔ 段"的转换，保持纯函数，谁都能调、随便测。
 */

import { ComponentType } from "./component.js"

/** 组件类型 → 适配器段名。仅用于手工构造的组件（有 `raw` 时用 `rawType`） */
const SEGMENT_NAMES = Object.freeze({
  [ComponentType.Plain]: "text",
  [ComponentType.Image]: "image",
  [ComponentType.At]: "at",
  [ComponentType.Reply]: "reply",
  [ComponentType.File]: "file",
  [ComponentType.Json]: "json",
  [ComponentType.Xml]: "xml",
  [ComponentType.Record]: "record",
  [ComponentType.Video]: "video",
  [ComponentType.Face]: "face",
  [ComponentType.Poke]: "poke",
  [ComponentType.Forward]: "forward",
  [ComponentType.Node]: "node",
  [ComponentType.Music]: "music",
  [ComponentType.Share]: "share",
  [ComponentType.Location]: "location",
  [ComponentType.Contact]: "contact",
  [ComponentType.Dice]: "dice",
  [ComponentType.Rps]: "rps",
  [ComponentType.Shake]: "shake",
})

/**
 * 把单个组件渲染成适配器认识的 segment。
 *
 * @param {import("./component.js").Component} component 组件
 * @returns {unknown} segment（来自真实 segment 的组件直接返回原对象）
 */
export function renderComponent(component) {
  if (component.raw !== undefined) return component.raw

  const { type, rawType, raw: _raw, ...fields } = component
  void _raw

  // 段名的优先级：原始段名 → 按组件类型反查 → 就用组件类型本身。
  // 最后那一步是刻意的：手工构造的组件即使类型不认识，也不该把名字丢掉。
  return {
    ...fields,
    type: rawType || SEGMENT_NAMES[/** @type {keyof typeof SEGMENT_NAMES} */ (type)] || type,
  }
}

/**
 * 把组件数组渲染成 segment 数组（保持顺序与长度）。
 *
 * @param {import("./component.js").Component[]} components 组件数组
 * @returns {unknown[]} segment 数组
 */
export function renderComponents(components) {
  return components.map(renderComponent)
}

/**
 * 组件类型 → 能力名。用于问适配器"这个组件你支持吗"。
 *
 * `Node`（合并转发的节点）与 `Forward` 共用 `forward` 能力；`Xml` 与 `Json`
 * 共用 `json`（两者在 OneBot 生态里都是"卡片"，能力上不可分）。
 * 未列出的类型没有对应能力，一律不参与能力判断。
 */
const CAPABILITY_OF_COMPONENT = Object.freeze({
  [ComponentType.Plain]: "text",
  [ComponentType.Image]: "image",
  [ComponentType.At]: "at",
  [ComponentType.Reply]: "reply",
  [ComponentType.Record]: "record",
  [ComponentType.Video]: "video",
  [ComponentType.Forward]: "forward",
  [ComponentType.Node]: "forward",
  [ComponentType.Poke]: "poke",
  [ComponentType.Json]: "json",
  [ComponentType.Xml]: "json",
})

/**
 * 取组件对应的能力名。
 *
 * @param {import("./component.js").Component} component 组件
 * @returns {string|undefined} 能力名；没有对应能力时 `undefined`
 */
export function capabilityOfComponent(component) {
  return CAPABILITY_OF_COMPONENT[
    /** @type {keyof typeof CAPABILITY_OF_COMPONENT} */ (component.type)
  ]
}
