/**
 * 原始 segment 数组 → `Component[]`。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.1。判定逻辑在 `component.js`，
 * 这里只负责数组层面的遍历与兜底。
 *
 * # 与现状的关系
 *
 * 现状（`NormalizeStage.parseMessage()` 与旧路径的 `PluginsLoader.dealEvent()`）
 * 是一边遍历一边就地往 `e` 上写字段，未识别的段**静默丢弃**。
 * 本模块只做"解析"，不碰事件对象：派生旧字段是 `legacy.js` 的事。
 * 这样两者可以各自单测，也让 `Unknown` 有了落脚点。
 */

import { ComponentType, parseSegment } from "./component.js"

/**
 * 解析一条消息的全部组件。
 *
 * - `message` 不是数组（缺失、字符串、`null`）时返回空数组——与现状一致，
 *   这种情况下一段派生字段都不会被写。
 * - 逐段调用 `parseSegment()`，**任何段都不会被丢掉**，认不出的一律
 *   `ComponentType.Unknown`，原始数据仍在 `raw` 上。
 *
 * @param {unknown} message 适配器给的 `message` 字段
 * @returns {import("./component.js").Component[]} 组件数组
 */
export function parseComponents(message) {
  if (!Array.isArray(message)) return []
  return message.map(parseSegment)
}

/**
 * 取出一批组件里未被识别的那些。
 *
 * 供调用方记 debug 日志用（见 `04-message-adapter.md` 的 Q2：未知组件**不**写进
 * `e.msg`，否则会改变正则匹配结果，那是行为变更）。
 *
 * @param {import("./component.js").Component[]} components 组件数组
 * @returns {import("./component.js").Component[]} 未知组件（可能为空）
 */
export function unknownComponents(components) {
  return components.filter(component => component.type === ComponentType.Unknown)
}
