import { bootstrapPipeline } from "./bootstrap.js"

/**
 * 流水线调度器：按 `STAGES_ORDER` 顺序执行阶段。
 *
 * 对应文档：docs/refactor/02-pipeline.md §5
 *
 * # 为什么没有洋葱模型（刻意的）
 *
 * AstrBot 的 pipeline 用了「洋葱模型」：阶段返回异步生成器，`yield` 之后执行下游。
 * 我们**不采纳**，理由有三条：
 *
 * 1. **在 Yunzai 里零消费者**。原计划只有 `StatisticsStage` 用它做耗时统计，
 *    而"整条流水线跑了多久"是**调度器**职责——`EventBus` 包住 `execute()` 就能测，
 *    不该由流水线内部承担。没有第二个用途。
 * 2. **参考实现已经废弃该设计**。AstrBot RFC #1948 把 pipeline 重构为 chain/workflow，
 *    明确写着「此次重构将替代现有的洋葱模型，所有基于该模型的功能模块均需重写」，
 *    更新说明是「实际落地为 chain 架构，简化了原有执行模型」——有序链正是当前这个形态。
 *    （https://github.com/AstrBotDevs/AstrBot/issues/1948）
 * 3. **该机制自带坑**。参考实现的洋葱分支在 `async for` 结束后，外层 `for` 会继续到 `i + 1`，
 *    于是洋葱阶段下游的所有阶段被**执行第二遍**——其 `content_safety_check/stage.py`
 *    在内容拦截路径上（`yield` → `stop_event()`）就会触发。对 Yunzai 而言，
 *    这等同于"同一条消息里插件被执行两次"。
 *
 * # 为将来预留的扩展点
 *
 * 如果将来确实需要「条件边 / 会话变量 / 会话锁」这类图状编排：
 *
 * - **Stage 仍是行为的唯一单元**，插件契约（`rule` / `handler` / `accept`）不需要改动；
 * - **顺序决策只存在于两处**——`stage-order.js` 的声明与这里的 `processStages` 执行，
 *   换成链/图引擎只动这两个文件；
 * - **会话变量已有雏形**：`ctx.stateOf(event)` 就是每事件的键值状态；
 * - **会话隔离已具备**：`PipelineContext` 按配置档案隔离（每档案一组阶段实例），
 *   `EventBus` 的串行队列等价于"会话锁"。
 *
 * 但**现在不做**：Yunzai 当前的痛点是"横切策略硬编码在 `deal()` 里"与
 * "插件靠 priority 魔数调度"，固定有序链已经解决；引入图状引擎属于提前抽象。
 */

/**
 * 依次执行从 `from` 开始的阶段。
 *
 * 阶段必须返回 `Promise`。若返回异步生成器（旧的洋葱写法），这里**直接抛错**：
 * `await` 一个生成器并不会执行它的函数体，不报错的话表现为"这个阶段什么都不做"，
 * 极难排查。把误用变成显式错误，比留一个静默失效的入口好。
 *
 * @param {import("./context.js").PipelineContext} ctx 流水线上下文
 * @param {Record<string, unknown>} event 事件对象
 * @param {number} [from] 从第几个阶段开始，缺省 0
 * @returns {Promise<void>}
 */
export async function processStages(ctx, event, from = 0) {
  for (let i = from; i < ctx.stages.length; i++) {
    const stage = ctx.stages[i]
    const produced = stage.process(event)

    if (isAsyncGenerator(produced))
      throw new Error(
        `${stage.constructor.name}.process() 返回了异步生成器。` +
          "洋葱模型已被否决（见 lib/pipeline/scheduler.js 顶部说明），阶段必须返回 Promise",
      )

    await produced
    if (ctx.isStopped(event)) break
  }
}

/**
 * 判断值是否为异步生成器（而非普通 Promise）。
 *
 * 仅用于把「误用洋葱写法」变成显式错误，不承载任何调度语义。
 *
 * @param {unknown} value 待判断的值
 * @returns {boolean}
 */
function isAsyncGenerator(value) {
  return (
    Boolean(value) && typeof (/** @type {object} */ (value)[Symbol.asyncIterator]) === "function"
  )
}

export class PipelineScheduler {
  /**
   * @param {import("./context.js").PipelineContext} ctx 流水线上下文
   */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * 校验注册表并实例化全部阶段。
   *
   * 必须在启动时调用一次；实例随后被所有消息复用（有状态阶段依赖这一点）。
   *
   * 阶段集合来自 `bootstrapPipeline()`——它负责 import 全部内置阶段并校验覆盖完整。
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    for (const StageClass of bootstrapPipeline()) {
      const stage = new StageClass()
      await stage.initialize(this.ctx)
      this.ctx.stages.push(stage)
    }
  }

  /**
   * 执行一次流水线。
   *
   * 不捕获异常——错误处理留给上层（`EventBus`）统一处理，
   * 以免在流水线中间吞掉堆栈。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async execute(event) {
    await processStages(this.ctx, event, 0)
  }
}
