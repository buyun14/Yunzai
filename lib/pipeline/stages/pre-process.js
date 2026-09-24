import { asChatTarget } from "../dispatch.js"
import { registerStage, Stage } from "../stage.js"

/**
 * 预处理：包装 `e.reply` + 注册 runtime。
 * 对应改造前的 `deal()` 第 7、8 步。
 *
 * # 为什么要包装 `e.reply`
 *
 * 插件拿到的是适配器提供的裸 `reply`，包装后统一获得：
 *
 * - `data.at` / `quote` 的注入（把 `[at, "\n", msg]` 拼到前面）；
 * - 发送失败不再抛出，而是记日志并返回 `{ error: [err] }`——
 *   这样插件里一句 `await this.reply(...)` 不会因为网络抖动中断整个处理流程；
 * - `data.recallMsg` 的定时撤回（同时撤回触发消息）；
 * - 发送计数。
 *
 * # 顺序敏感
 *
 * 必须在 `ProcessStage` 之前：插件在 `rule` / `accept` 里调用的就是包装后的 `reply`。
 *
 * # 两个刻意的取舍
 *
 * 1. **发送计数不 await**（与旧实现一致）。发送路径上不引入额外等待，
 *    代价是 redis 写失败会变成未处理的 rejection。改变它属于行为变更，已登记为后续事项。
 * 2. **包装不可重入**：同一个事件被包装两次会叠加注入。正常流程每条事件只走一次，
 *    但**影子运行必须使用事件副本**，否则会看到叠加后的行为。
 */
export class PreProcessStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    this.wrapReply(event)
    await this.ctx.runtime?.init?.(event)
  }

  /**
   * 包装 `e.reply`。语义与 `PluginsLoader.reply()` 逐条对应。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {void}
   */
  wrapReply(event) {
    /**
     * 适配器给出的裸 `reply`。事件对象是动态的，这里显式声明可调用形状。
     *
     * @type {{ bind?: (thisArg: unknown) => (msg: unknown) => Promise<unknown> }|undefined}
     */
    const bare =
      /** @type {typeof undefined|{ bind: (thisArg: unknown) => (msg: unknown) => Promise<unknown> }} */ (
        event.reply
      )
    if (typeof bare?.bind !== "function") return
    const send = bare.bind(event)

    /**
     * @param {unknown} msg 发送的消息
     * @param {boolean} [quote] 是否引用回复
     * @param {{ recallMsg?: number, at?: unknown }} [data] 追加选项
     * @returns {Promise<unknown>} 发送结果
     */
    event.reply = async (msg = "", quote = false, data = {}) => {
      if (!msg) return false

      let { recallMsg = 0, at = "" } = data

      if (at && event.isGroup) {
        if (at === true) at = event.user_id
        if (Array.isArray(msg)) msg.unshift(segment.at(at), "\n")
        else msg = [segment.at(at), "\n", msg]
      }

      if (quote && event.message_id) {
        if (Array.isArray(msg)) msg.unshift(segment.reply(event.message_id))
        else msg = [segment.reply(event.message_id), msg]
      }

      let res
      try {
        res = await send(msg)
      } catch (err) {
        Bot.makeLog("error", ["发送消息错误", msg, err], event.self_id)
        res = { error: [err] }
      }

      const chat = asChatTarget(event.group ?? event.friend)
      const result = /** @type {{ message_id?: unknown }} */ (res ?? {})
      if (recallMsg > 0 && result.message_id && chat.recallMsg)
        setTimeout(() => {
          chat.recallMsg?.(result.message_id)
          if (event.message_id) chat.recallMsg?.(event.message_id)
        }, recallMsg * 1000)

      // 与旧实现一致：不 await（发送路径上不引入额外等待）
      void this.ctx.loader.count(event, "send", msg)
      return res
    }
  }
}

registerStage(PreProcessStage)
