import lodash from "lodash"
import { asChatTarget, normalizeText, shouldReplyOnlyAt, truncateForLog } from "../dispatch.js"
import { registerStage, Stage } from "../stage.js"

/**
 * 事件归一化：把适配器载荷变成插件可见的字段。
 *
 * 对应 `PluginsLoader.deal()` 的第 5 步（`dealEvent`）。
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
 */
export class NormalizeStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    const slashToHash = this.ctx.cfg?.bot?.["/→#"] ?? true

    this.parseMessage(event, slashToHash)
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
   * 解析 `message` 数组，拼出 `msg` / `img` / `at` / `atBot` / `file` / `reply_id` / `getReply`。
   *
   * ⚠️ 未识别的段类型**被静默忽略**——这是改造前的既有行为，本阶段不改（见
   * `tests/fixtures/events/group-unsupported-segments.json`）。要改变它属于行为变更，
   * 应作为 `lib/message/` 统一消息模型的独立议题（阶段 4）。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @param {boolean} slashToHash 文本归一化时是否把前导 `/` 转成 `#`
   * @returns {void}
   */
  parseMessage(event, slashToHash) {
    const message = /** @type {Array<Record<string, unknown>>|undefined} */ (event.message)
    if (!message) return

    for (const segment of message) {
      switch (segment.type) {
        case "text":
          event.msg = `${event.msg || ""}${normalizeText(/** @type {string} */ (segment.text), slashToHash)}`
          break
        case "image":
          if (Array.isArray(event.img)) event.img.push(segment.url)
          else event.img = [segment.url]
          break
        case "at":
          if (segment.qq == event.self_id) event.atBot = true
          else event.at = segment.qq
          break
        case "reply": {
          event.reply_id = segment.id
          const group = asChatTarget(event.group)
          const friend = asChatTarget(event.friend)
          if (group.getMsg) event.getReply = () => group.getMsg?.(event.reply_id)
          else if (friend.getMsg) event.getReply = () => friend.getMsg?.(event.reply_id)
          break
        }
        case "file":
          event.file = segment
          break
        case "xml":
        case "json":
          event.msg = `${event.msg || ""}${typeof segment.data === "string" ? segment.data : JSON.stringify(segment.data)}`
          break
      }
    }
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
