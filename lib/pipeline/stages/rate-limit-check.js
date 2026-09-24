import { umoOf } from "../../message/umo.js"
import { registerStage, Stage } from "../stage.js"

/**
 * 限流检查：禁言 + 群冷却 + 单人冷却 + 同文去重。
 * 对应 `PluginsLoader.deal()` 的第 4 步（`checkLimit`）。
 *
 * # 为什么和"提交冷却"拆成两个阶段
 *
 * 直觉上「检查 + 提交」应该是一个阶段，但现状不支持：
 *
 * - 提交的条件 `e.only_reply_at` 由 `NormalizeStage`（第 5 步）算出；
 * - 提交必须在插件执行**之前**生效，否则插件里一段耗时数秒的渲染会让群内其他消息
 *   在这段时间内不被冷却拦截。
 *
 * 于是检查（第 4 步）与提交（第 6 步）之间必须夹着归一化，**不能**连在一起。
 *
 * # 位置敏感：必须在 NormalizeStage 之前
 *
 * 本阶段的 `!event.message || event.isPrivate` 早退分支读的是 `e.isPrivate`，
 * 而该字段只有 `NormalizeStage` 才赋值。也就是说**私聊消息在这里
 * `e.isPrivate === undefined`，不会早退**，会继续走到 `msgThrottle` 去重。
 * 把归一化提前会静默改变私聊的限流行为（见 `02-pipeline.md` §2.2 约束 a）。
 *
 * # 状态按配置档案隔离
 *
 * `groupCD` / `singleCD` / `msgThrottle` 是本阶段的**实例字段**，而阶段实例按配置档案
 * 一组一份（见 `PipelineContext`），因此多账号同群不再互相拦截。
 * 旧实现把它们放在 `PluginsLoader` 单例上，且键里漏了 `self_id`——这是被顺手修掉的缺陷。
 *
 * # 键已经换成 umo，但群冷却那一处没换（阶段 4 v2）
 *
 * `singleCD` / `msgThrottle` 的键改用 `umoOf(event)`：前者 `${umo}.${user_id}`，
 * 后者 `${umo}:${user_id}:${raw_message}`。同一个档案内 `umo` 与原键一一对应，
 * 所以群聊的单账号行为完全不变；变化只发生在两处跨会话场景：
 *
 * - 同一个人在**不同群**发同一句话，1 秒内第二条原本会被去重（旧键里没有群号）；
 * - 私聊的 `singleCD` 键原本是 `undefined.${user_id}`——同一个档案下的所有私聊
 *   共用一套单人冷却；现在是 `per-对端` 一套。
 *
 * `groupCD` 那一处**故意没换**：它的键是 `group_id`。换成 `umo` 会顺带改掉
 * “私聊共用同一个群冷却桶”（旧键是字符串 `"undefined"`）这个行为，
 * 而“私聊到底该不该走群冷却”需要单独决定——已登记为 O7，不在本阶段处理。
 */
export class RateLimitCheckStage extends Stage {
  /** 群冷却：`群号` → true */
  groupCD = {}

  /** 单人冷却：`群号.用户号` → true */
  singleCD = {}

  /** 同文去重：`bot:用户:原文` → true（1 秒） */
  msgThrottle = {}

  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    /** 禁言中：群被全员禁言且发言者既不是管理也不是群主 */
    const group = asGroup(event.group)
    if (group && (group.mute_left > 0 || (group.all_muted && !group.is_admin && !group.is_owner)))
      return this.stop(event)

    // 注意：这里读的 isPrivate 在本阶段尚未赋值（由 NormalizeStage 赋值），
    // 因此私聊消息不会在此早退——与旧实现一致，勿改
    if (!event.message || event.isPrivate) return

    const config = this.resolveGroupCfg(event)
    const umo = umoOf(event)

    if (config?.groupCD && this.groupCD[/** @type {string} */ (event.group_id)])
      return this.stop(event)

    const singleKey = `${umo}.${event.user_id}`
    if (config?.singleCD && this.singleCD[singleKey]) return this.stop(event)

    const msgId = `${umo}:${event.user_id}:${event.raw_message}`
    if (this.msgThrottle[msgId]) return this.stop(event)

    this.msgThrottle[msgId] = true
    setTimeout(() => delete this.msgThrottle[msgId], 1000)
  }

  /**
   * 取群配置：优先用 `ProfileResolveStage` 解析好的结果，缺失时自行兜底
   * （与旧实现 `config ||= cfg.getGroup(...)` 的行为一致）。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Record<string, unknown>|null} 群配置
   */
  resolveGroupCfg(event) {
    const resolved = this.stateOf(event).groupCfg
    if (resolved) return /** @type {Record<string, unknown>} */ (resolved)
    return /** @type {Record<string, unknown>} */ (
      this.ctx.cfg.getGroup(event.self_id, event.group_id)
    )
  }
}

/**
 * @typedef {object} GroupState
 * @property {number} [mute_left] 剩余禁言秒数
 * @property {boolean} [all_muted] 是否全员禁言
 * @property {boolean} [is_admin] 发送者是否群管理
 * @property {boolean} [is_owner] 发送者是否群主
 */

/**
 * 把 `event.group` 收窄成群状态对象。事件对象是动态的，这里集中收窄一次。
 *
 * @param {unknown} value 待收窄的值
 * @returns {GroupState|null} 群对象，缺失时为 null
 */
function asGroup(value) {
  return value ? /** @type {GroupState} */ (value) : null
}

registerStage(RateLimitCheckStage)
