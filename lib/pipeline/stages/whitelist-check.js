import { matchId } from "../dispatch.js"
import { registerStage, Stage } from "../stage.js"

/**
 * 用户 / 群黑白名单。对应改造前的 `deal()` 第 2 步（`checkBlack`）。
 *
 * 语义（**逐条对应旧实现，注意白名单是"不在名单里就拦"的反向逻辑**）：
 *
 * 1. 命中黑名单用户 → 拦；
 * 2. 配了白名单用户且不在其中 → 拦；
 * 3. 群聊时命中黑名单群 → 拦；
 * 4. 群聊时配了白名单群且不在其中 → 拦。
 *
 * `matchId` 负责"数字 / 字符串两种写法"的比对，见其注释。
 */
export class WhitelistCheckStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    const other = this.ctx.cfg.getOther()

    if (matchId(other.blackUser, event.user_id)) return this.stop(event)
    if (other.whiteUser?.length && !matchId(other.whiteUser, event.user_id)) return this.stop(event)

    if (!event.group_id) return

    if (matchId(other.blackGroup, event.group_id)) return this.stop(event)
    if (other.whiteGroup?.length && !matchId(other.whiteGroup, event.group_id))
      return this.stop(event)
  }
}

registerStage(WhitelistCheckStage)
