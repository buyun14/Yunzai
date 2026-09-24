/**
 * `Component[]` → 现有的派生字段（`e.msg` / `e.img` / `e.atBot` / `e.at` /
 * `e.file` / `e.reply_id` / `e.getReply`）。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.2 的 v1。
 *
 * # 语义要求：与改造前逐字等价
 *
 * 这些字段是 **L0 冻结面**——插件生态大量直接读 `e.msg`，正则、`startsWith`、
 * `includes` 全都建立在它们的精确取值上。所以这个文件里的每一行都对应
 * `NormalizeStage.parseMessage()`（它的前身是已删除的旧 `PluginsLoader.dealEvent()`）
 * 的一个分支，包括那些看起来奇怪的地方：
 *
 * - 文本用 `(e.msg || "")` 累加，所以纯图片消息的 `e.msg` 是 `undefined` 而不是 `""`；
 * - `at` 用宽松比较 `==`，于是 `"123"` 与 `123` 都算 at 到机器人；
 * - `getReply` 闭包读的是**调用时**的 `event.reply_id`，不是捕获的段内 id；
 * - `e.file` 是整个原始 segment 对象（见 `component.js` 里关于 `raw` 的说明）；
 * - `xml` / `json` 的载荷是字符串就直接拼，否则 `JSON.stringify`。
 *
 * # 为什么要去 import 流水线的函数
 *
 * `normalizeText` / `asChatTarget` 是阶段 2 从旧 loader 抄到
 * `lib/pipeline/dispatch.js` 的语义（`/→#` 归一化、`group`/`friend` 收窄）。
 * 本模块的职责就是复刻那套语义，自己再抄一份只会制造第二个真相来源。
 *
 * 注：原计划是「阶段 2 第 5 步删掉旧路径时这个文件会一起消失」，实际没发生——
 * 派生的这批字段是 L0 冻结面，旧路径没了它们也还得在。
 */

import { asChatTarget, normalizeText } from "../pipeline/dispatch.js"
import { ComponentType } from "./component.js"

/**
 * 把组件数组派生成事件上的旧字段。
 *
 * 只**新增**字段，不改写 `event.message`；`msg` 的累加与 `e.file` 的原样传出
 * 是仅有的两处"就地写"，与改造前一致。
 *
 * @param {Record<string, unknown>} event 事件对象（就地修改）
 * @param {import("./component.js").Component[]} components 组件数组
 * @param {{ slashToHash?: boolean }} [options] `slashToHash` 取自 `config/bot.yaml`
 *   的 `/→#`，缺省按 true（与默认配置一致）
 * @returns {void}
 */
export function applyLegacyFields(event, components, { slashToHash = true } = {}) {
  for (const component of components) {
    switch (component.type) {
      case ComponentType.Plain:
        event.msg = `${event.msg || ""}${normalizeText(/** @type {string} */ (component.text), slashToHash)}`
        break

      case ComponentType.Image:
        if (Array.isArray(event.img)) event.img.push(component.url)
        else event.img = [component.url]
        break

      case ComponentType.At:
        if (component.qq == event.self_id) event.atBot = true
        else event.at = component.qq
        break

      case ComponentType.Reply: {
        event.reply_id = component.id
        const group = asChatTarget(event.group)
        const friend = asChatTarget(event.friend)
        if (group.getMsg) event.getReply = () => group.getMsg?.(event.reply_id)
        else if (friend.getMsg) event.getReply = () => friend.getMsg?.(event.reply_id)
        break
      }

      case ComponentType.File:
        event.file = component.raw
        break

      case ComponentType.Xml:
      case ComponentType.Json:
        event.msg = `${event.msg || ""}${typeof component.data === "string" ? component.data : JSON.stringify(component.data)}`
        break
    }
  }
}
