import lodash from "lodash"
import { callables, instantiate, isPluginEnabled, matchesEvent } from "../dispatch.js"
import { registerStage, Stage } from "../stage.js"

/**
 * 插件筛选 + context hook + 唤醒门槛。对应 `PluginsLoader.deal()` 的第 9、10、11 步。
 *
 * 三步放在同一个阶段是因为它们**内部顺序敏感**且共享同一份 `priority` 列表：
 *
 * 1. 按 `checkDisable` + `filtEvent` 筛出本轮参与调度的插件，写进事件状态；
 * 2. 依次调用插件的 `getContext()` 钩子——**无论是否唤醒都会执行**；
 * 3. 最后才是唤醒门槛 `if (!e.only_reply_at) return`。
 *
 * ⚠️ 第 3 步必须在第 2 步**之后**（旧实现的行序如此）。把门槛提前会让 `getContext()`
 * 钩子在不该运行的场景下少跑一次，插件的状态机会错乱。见 `02-pipeline.md` §2.2 约束 c。
 *
 * `priority` 列表写入事件状态后由 `ProcessStage` 消费——两个阶段之间通过状态传递，
 * 而不是让 `ProcessStage` 重新筛一遍（那样两次筛选结果可能不一致）。
 */
export class WakeupGateStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    const state = this.stateOf(event)
    const config = /** @type {Record<string, unknown>} */ (
      state.groupCfg ?? this.ctx.cfg.getGroup(event.self_id, event.group_id)
    )

    // 第 9 步：筛选
    const priority = []
    for (const entry of this.ctx.loader.priority)
      if (
        isPluginEnabled(/** @type {string} */ (entry.plugin.name), config) &&
        matchesEvent(event, entry.plugin)
      )
        priority.push(entry)
    state.priority = priority

    // 第 10 步：context hook
    for (const entry of priority) {
      const raw = entry.plugin.getContext
      if (typeof raw !== "function") continue
      const getContext =
        /** @type {(isGroup?: boolean, isCurrent?: boolean) => Record<string, unknown>} */ (raw)

      // 刻意调用两次：第一段是"所有上下文的集合"，第二段是"当前上下文"，
      // 合并后覆盖前者——与旧实现一致，勿合并调用
      const context = { ...getContext(), ...getContext(false, true) }
      if (lodash.isEmpty(context)) continue

      const instance = callables(instantiate(entry, event))
      let ret
      for (const fnc in context) ret ||= await instance[fnc](context[fnc])

      // 返回 "continue" 表示放行给后面的插件，否则本条消息到此为止
      if (ret === "continue") continue
      return this.stop(event)
    }

    // 第 11 步：唤醒门槛
    if (!event.only_reply_at) this.stop(event)
  }
}

registerStage(WakeupGateStage)
