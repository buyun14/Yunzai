import lodash from "lodash"
import { applyLegacyFields } from "../../message/legacy.js"
import { parseComponents, unknownComponents } from "../../message/parse.js"
import { umoOf } from "../../message/umo.js"
import { asChatTarget, shouldReplyOnlyAt, truncateForLog } from "../dispatch.js"
import { registerStage, Stage } from "../stage.js"

/**
 * 事件归一化：把适配器载荷变成插件可见的字段。
 *
 * 对应改造前的 `deal()` 第 5 步（`dealEvent`）。
 *
 * # 位置敏感，不要重排
 *
 * 这个阶段必须在 `RateLimitCheckStage` **之后**（见 `stage-order.js` 的说明）：
 * `checkLimit` 会读 `e.isPrivate`，而该字段只有本阶段才赋值。私聊消息在限流检查时
 * `e.isPrivate === undefined`，因此**不会**走 `checkLimit` 的早退分支，而是继续走到
 * `msgThrottle` 去重。把本阶段提前会静默改变私聊的限流行为。
 *
 * # 只增不改
 *
 * 所有产出都是**新增**字段（`msg` / `img` / `atBot` / `isPrivate` / `logText` / …），
 * 不改写适配器提供的原始字段（`message` / `raw_message` / `sender` / `group` 等）。
 * 例外是 `msg` 的别名剥离与 `sender.card` 的兜底——这两处在旧实现里同样是就地修改。
 *
 * 阶段 4 v1 又新增了一个 `components`（统一消息组件，见 `lib/message/`）。
 * 它是纯粹的新增字段：旧路径不产出它，影子对比也从不比较它。
 */
export class NormalizeStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    const slashToHash = this.ctx.cfg?.bot?.["/→#"] ?? true

    this.parseMessage(event, slashToHash)

    // 会话唯一键：谁（adapter + self_id）在哪个作用域的哪个对端。
    // 由本阶段产出是因为它是插件可见字段；限流阶段在它之前就已经算过一遍
    // （`umoOf()` 是纯函数，两边算出的结果必然相同）。
    event.umo = umoOf(event)

    // 跨账号排查时，“同一句话在哪个会话”比“哪个群”更准——尤其多账号同群时。
    // 刻意只进 debug 日志、**不写进 `e.logText`**：后者是插件可见面，
    // 改它会影响插件的字符串处理，属于行为变更。插件需要时直接读 `e.umo`。
    logger.debug(`[umo] ${event.umo}`)

    this.markScope(event)
    this.markMaster(event)

    // 与旧实现一致：`onlyReplyAt` 内部会做 `groupCfg ||= cfg.getGroup(...)` 的兜底，
    // 因此这里也必须兜底——否则 ProfileResolveStage 缺席时会直接对 null 取属性
    const groupCfg =
      this.stateOf(event).groupCfg ?? this.ctx.cfg.getGroup(event.self_id, event.group_id)
    this.stripAlias(event, groupCfg)
    event.only_reply_at = shouldReplyOnlyAt(event, groupCfg)
  }

  /**
   * 解析 `message` 数组，产出 `components`，并派生出
   * `msg` / `img` / `at` / `atBot` / `file` / `reply_id` / `getReply`。
   *
   * 解析与派生分别交给 `lib/message/parse.js` 与 `lib/message/legacy.js`：
   * 前者只把原始 segment 变成组件（未识别的不再丢弃），后者负责复刻历史语义。
   *
   * ⚠️ 派生出的旧字段取值必须与改造前**逐字一致**，它们的语义陷阱
   * （`e.msg` 在纯图片消息上是 `undefined`、`at` 用宽松比较等）都记在
   * `lib/message/legacy.js` 的头部注释里。未识别的段**只**进 `components`，
   * **不**写进 `e.msg`——写进去会改变正则匹配结果（见 `04-message-adapter.md` 的 Q2）。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @param {boolean} slashToHash 文本归一化时是否把前导 `/` 转成 `#`
   * @returns {void}
   */
  parseMessage(event, slashToHash) {
    const components = parseComponents(event.message)

    // 无条件设置：通知/请求类事件没有 `message`，它们的 `components` 就是空数组，
    // 这样插件不必写 `e.components ?? []`。
    event.components = components

    applyLegacyFields(event, components, { slashToHash })
    this.logUnknownComponents(components)
  }

  /**
   * 未识别的段类型记 debug 日志。
   *
   * 改造前这些段是静默丢弃的，出问题时看不出任何痕迹；现在至少留下
   * “收到了什么名字、被归入了 Unknown”。级别用 debug，不污染正常日志。
   *
   * @param {import("../../message/component.js").Component[]} components 组件数组
   * @returns {void}
   */
  logUnknownComponents(components) {
    const unknown = unknownComponents(components)
    if (!unknown.length) return
    logger.debug(`[消息解析] 未识别的段类型：${unknown.map(item => item.rawType).join(", ")}`)
  }

  /**
   * 判定群聊/私聊、拼日志前缀、挂上 `recall`。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {void}
   */
  markScope(event) {
    event.logText = ""
    const sender = /** @type {{ nickname?: string, card?: string }|undefined} */ (event.sender)
    if (sender) sender.card ||= sender.nickname

    if (event.message_type === "private" || event.notice_type === "friend") {
      event.isPrivate = true
      event.logText = `[${sender?.nickname ? `${sender.nickname}(${event.user_id})` : event.user_id}]`

      const friend = asChatTarget(event.friend)
      if (!event.recall && event.message_id && friend.recallMsg)
        event.recall = friend.recallMsg.bind(event.friend, event.message_id)
    } else if (event.message_type === "group" || event.notice_type === "group") {
      event.isGroup = true
      event.logText = `[${event.group_name ? `${event.group_name}(${event.group_id})` : event.group_id}, ${
        sender?.card ? `${sender.card}(${event.user_id})` : event.user_id
      }]`

      const group = asChatTarget(event.group)
      if (!event.recall && event.message_id && group.recallMsg)
        event.recall = group.recallMsg.bind(event.group, event.message_id)
    }

    const summary = event.msg || event.raw_message || Bot.String(event)
    event.logText = `${logger.cyan(event.logText)}${logger.red(`[${truncateForLog(summary)}]`)}`
  }

  /**
   * 判定是否为主人。对应用户配置 `config/other.yaml` 的 `masters`（Bot:主人 的映射）。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {void}
   */
  markMaster(event) {
    const master = /** @type {Record<string, string[]>|undefined} */ (this.ctx.cfg?.master)
    if (
      event.user_id &&
      master?.[/** @type {string} */ (event.self_id)]?.includes(String(event.user_id))
    )
      event.isMaster = true
  }

  /**
   * 剥离群聊消息的 `botAlias` 前缀（仅在**未 at 机器人**的群聊文本消息上生效）。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @param {object|null} groupCfg 群配置
   * @returns {void}
   */
  stripAlias(event, groupCfg) {
    if (!event.msg || !event.isGroup || event.atBot) return

    const alias = lodash.get(groupCfg ?? {}, "botAlias")
    for (const prefix of Array.isArray(alias) ? alias : [alias])
      if (prefix && String(event.msg).startsWith(prefix)) {
        event.msg = String(event.msg).replace(prefix, "")
        event.hasAlias = true
        break
      }
  }
}

registerStage(NormalizeStage)
