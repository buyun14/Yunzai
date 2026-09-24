import { PIPELINE_STATE } from "./context-state.js"

/**
 * @typedef {object} PipelineEventState
 * @property {boolean} stopped 是否已停止向下游传播
 * @property {number} startTime 进入流水线的时间戳（由 StatisticsStage 记录）
 * @property {object|null} groupCfg 解析出的群配置
 * @property {Array<object>|null} priority 本轮参与调度的插件列表
 */

/**
 * 把事件对象视为“可按 Symbol 取属性”的容器。
 *
 * TS 不允许把 `unique symbol` 直接当作 `Record<string, unknown>` 的索引，
 * 这是纯类型层面的绕行，运行时不产生任何操作。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @returns {Record<symbol, unknown>} 同一对象
 */
function symbolHolder(event) {
  return /** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (event))
}

/**
 * 流水线上下文。
 *
 * 对应文档：docs/refactor/02-pipeline.md §6
 *
 * ## 一个上下文对应一个「配置档案」
 *
 * 改造前 `PluginsLoader` 是单例，因此 `groupCD` / `singleCD` 是所有账号共享的一张表，
 * 键里还漏了 `self_id`——同一个群里挂两个 bot 账号时，A 账号触发群冷却会让 B 账号
 * 也被静默拦截（见文档 §2.1 问题 C）。
 *
 * 现在每个档案一组独立的阶段实例，限流表天然以档案为界。
 *
 * ## 每事件状态存在事件对象的 Symbol 键上
 *
 * 用 `Object.defineProperty` 写成**不可枚举**：
 * - Symbol 键本身就不会出现在 `Object.keys` / `JSON.stringify` 里；
 * - 但 `Object.assign({}, e)` 会复制**可枚举**的 Symbol 属性，所以必须显式设 `enumerable: false`；
 * - 不占用任何插件可见的 `e.*` 字段名，因此不需要改动 L0 冻结面。
 */
export class PipelineContext {
  /**
   * @param {object} opts 构造参数
   * @param {object} opts.loader 插件加载器（阶段通过它访问插件列表与筛选方法）
   * @param {string} opts.profileKey 配置档案标识（当前为 bot 账号 `self_id`）
   * @param {object} opts.cfg 宿主配置对象（即 `lib/config/config.js`）
   *   阶段**不得**自行 `import` 配置文件——从上下文取才能被单测注入替身
   */
  constructor({ loader, profileKey, cfg }) {
    this.loader = loader
    this.profileKey = profileKey
    this.cfg = cfg
    /**
     * 已按 `STAGES_ORDER` 排好序的阶段实例。**长生命周期**：
     * 阶段的有状态字段（限流计数、缓存）依赖实例不被重建。
     *
     * @type {Array<import("./stage.js").Stage>}
     */
    this.stages = []
  }

  /**
   * 取（必要时创建）某个事件的流水线状态。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {PipelineEventState} 流水线状态
   */
  stateOf(event) {
    const holder = symbolHolder(event)
    let state = /** @type {PipelineEventState|undefined} */ (holder[PIPELINE_STATE])
    if (!state) {
      /** @type {PipelineEventState} */
      state = { stopped: false, startTime: 0, groupCfg: null, priority: null }
      Object.defineProperty(holder, PIPELINE_STATE, {
        value: state,
        enumerable: false,
        configurable: true,
        writable: true,
      })
    }
    return state
  }

  /**
   * 停止向下游传播。语义对应改造前 `deal()` 里的 `return`。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {void}
   */
  stop(event) {
    this.stateOf(event).stopped = true
  }

  /**
   * 是否已停止传播。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {boolean}
   */
  isStopped(event) {
    const state = /** @type {PipelineEventState|undefined} */ (symbolHolder(event)[PIPELINE_STATE])
    return state?.stopped === true
  }
}
