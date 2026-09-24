/**
 * 消息流水线的阶段基类与注册表。
 *
 * 对应文档：docs/refactor/02-pipeline.md
 *
 * ## 阶段 = 一段有位置意义的横切逻辑
 *
 * 每个阶段只做一件事，执行顺序由 `lib/pipeline/stage-order.js` 的 `STAGES_ORDER` 声明，
 * 注册表与它必须严格一一对应。
 *
 * ## 阶段必须返回 Promise
 *
 * 实现 `async process(event)` 即可。**不使用异步生成器**——洋葱模型已被否决，
 * 理由（零消费者 / 参考实现已废弃 / 机制自带坑）见 `scheduler.js` 顶部说明。
 */

/**
 * 已注册的阶段类。
 *
 * 注册顺序不重要——执行顺序由 `lib/pipeline/stage-order.js` 的 `STAGES_ORDER` 决定，
 * 且要求两者严格一一对应（见 `assertStageCoverage`）。
 *
 * @type {Array<new () => Stage>}
 */
export const registeredStages = []

/**
 * 把一个阶段类登记进注册表。
 *
 * 用装饰器形式是为了让"新增一个阶段"只需两处改动：写类 + 在 `STAGES_ORDER` 里定位。
 *
 * @template {new () => Stage} T
 * @param {T} stageClass 阶段类
 * @returns {T} 原样返回，便于 `export default` 组合
 */
export function registerStage(stageClass) {
  if (registeredStages.includes(stageClass)) throw new Error(`阶段 ${stageClass.name} 被重复注册`)
  registeredStages.push(stageClass)
  return stageClass
}

/**
 * 清空注册表。仅供测试使用。
 */
export function clearRegisteredStages() {
  registeredStages.length = 0
}

export class Stage {
  /** @type {import("./context.js").PipelineContext} */
  ctx

  /**
   * 初始化阶段，只在调度器构建时调用一次。
   *
   * 阶段实例是**长生命周期**的（每个配置档案一组），因此这里适合初始化
   * 限流计数器、缓存表等有状态的东西。
   *
   * @param {import("./context.js").PipelineContext} ctx 流水线上下文
   * @returns {Promise<void>}
   */
  async initialize(ctx) {
    this.ctx = ctx
  }

  /**
   * 取本事件的流水线状态。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {import("./context.js").PipelineEventState} 状态对象
   */
  stateOf(event) {
    return this.ctx.stateOf(event)
  }

  /**
   * 停止向下游传播。语义对应改造前 `deal()` 里的 `return`。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {void}
   */
  stop(event) {
    this.ctx.stop(event)
  }

  /**
   * 是否已停止传播。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {boolean}
   */
  isStopped(event) {
    return this.ctx.isStopped(event)
  }

  /**
   * 处理事件。
   *
   * 子类必须实现，并且**必须返回 `Promise`**（写成 `async process(event)`）。
   * 返回异步生成器会被调度器显式拒绝，原因见 `scheduler.js` 顶部说明。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  process(event) {
    throw new Error(`${this.constructor.name} 未实现 process()`)
  }
}
