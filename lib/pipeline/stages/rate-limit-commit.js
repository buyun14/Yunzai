import { umoOf } from "../../message/umo.js"
import { registerStage, Stage } from "../stage.js"
import { RateLimitCheckStage } from "./rate-limit-check.js"

/**
 * 提交冷却。对应 `PluginsLoader.deal()` 的第 6 步（`setLimit`）。
 *
 * # 时序契约
 *
 * 1. 必须在 `NormalizeStage` **之后**——提交条件是 `e.only_reply_at`，由归一化算出；
 * 2. 必须在 `ProcessStage` **之前**——见 `rate-limit-check.js` 的说明。
 *
 * # 为什么去 `ctx.stages` 里取另一个阶段
 *
 * 冷却表由 `RateLimitCheckStage` 持有（它是读取方，也是"检查/提交"两半的天然主人）。
 * 两个阶段共用一份状态，又不能各自持有一份（那样检查与提交会读到不同的表）。
 *
 * 取实例的时机是安全的：`PipelineScheduler.initialize()` 严格按 `STAGES_ORDER` 顺序
 * 初始化，`RateLimitCheckStage`（第 4 位）必然先于本阶段（第 6 位）完成初始化，
 * 因此这里能拿到实例；取不到就显式抛错，而不是静默地用一份空表。
 */
export class RateLimitCommitStage extends Stage {
  /** @type {RateLimitCheckStage} */
  rateLimit

  /**
   * @param {import("../context.js").PipelineContext} ctx 流水线上下文
   * @returns {Promise<void>}
   */
  async initialize(ctx) {
    await super.initialize(ctx)

    const found = ctx.stages.find(stage => stage instanceof RateLimitCheckStage)
    if (!(found instanceof RateLimitCheckStage))
      throw new Error(
        "RateLimitCommitStage 需要 RateLimitCheckStage 先完成初始化（检查 STAGES_ORDER 的顺序）",
      )
    this.rateLimit = found
  }

  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    if (!event.only_reply_at) return
    if (event.isPrivate) return

    const config = /** @type {Record<string, unknown>} */ (
      this.stateOf(event).groupCfg ?? this.ctx.cfg.getGroup(event.self_id, event.group_id)
    )

    if (config.groupCD) {
      const groupId = /** @type {string} */ (event.group_id)
      this.rateLimit.groupCD[groupId] = true
      setTimeout(
        () => delete this.rateLimit.groupCD[groupId],
        /** @type {number} */ (config.groupCD),
      )
    }

    if (config.singleCD) {
      // 键必须与 RateLimitCheckStage 完全一致，因此两边都调 umoOf()
      const key = `${umoOf(event)}.${event.user_id}`
      this.rateLimit.singleCD[key] = true
      setTimeout(() => delete this.rateLimit.singleCD[key], /** @type {number} */ (config.singleCD))
    }
  }
}

registerStage(RateLimitCommitStage)
