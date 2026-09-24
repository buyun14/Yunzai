import { registerStage, Stage } from "../stage.js"

/**
 * 接收统计。对应 `PluginsLoader.deal()` 的第 1 步。
 *
 * # 为什么耗时统计不在这里
 *
 * 原计划用洋葱模型的前置/后置钩子在同一个阶段里测"整条流水线耗时"。洋葱模型已被否决
 * （理由见 `scheduler.js` 顶部），而"整条流水线跑了多久"本来就是**调度器**职责：
 * `EventBus` 在 `execute()` 外面包一层即可，比在流水线内部穿针引线更直接。
 *
 * # 计数实现仍在 loader 上
 *
 * `count` / `saveCounts` 是**服务**而不是横切策略——它没有决策分支、不影响消息流向，
 * 因此保留在 `PluginsLoader` 上，本阶段只调用。这也意味着影子运行时两侧共用同一份计数
 * 实现（无害：计数不参与"决策序列"的比对），但**会有实际写 redis 的副作用**，
 * 因此影子运行必须跳过本阶段（见 `02-pipeline.md` §7 的注意事项）。
 */
export class StatisticsStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    await this.ctx.loader.count(event, "receive", event.message)
  }
}

registerStage(StatisticsStage)
