import { registerStage, Stage } from "../stage.js"

/**
 * 解析本事件的群配置。对应改造前的 `deal()` 第 3 步。
 *
 * 把结果写进事件状态（`state.groupCfg`），后续阶段统一从那里取，
 * 避免像旧实现那样在多个方法里各自做 `groupCfg ||= cfg.getGroup(...)` 的兜底，
 * 也保证每条事件**只解析一次**。
 *
 * 注意这里对私聊同样调用 `getGroup(self_id, undefined)`——与旧实现一致
 * （旧实现无条件传入 `e.group_id`，私聊时其值为 `undefined`，
 * 因此 `getGroup` 会回落到 `default` 段）。不要"顺手优化"成跳过私聊：
 * `RateLimitCommitStage` 与 `WakeupGateStage` 都依赖同一个解析结果。
 */
export class ProfileResolveStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    this.stateOf(event).groupCfg = this.ctx.cfg.getGroup(event.self_id, event.group_id)
  }
}

registerStage(ProfileResolveStage)
