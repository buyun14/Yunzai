import { PIPELINE_STATE } from "./context-state.js"

/**
 * @typedef {object} PipelineEventState
 * @property {boolean} stopped 是否已停止向下游传播
 * @property {object|null} groupCfg 解析出的群配置（由 `ProfileResolveStage` 写入）
 * @property {PluginEntry[]|null} priority 本轮参与调度的插件（由 `WakeupGateStage` 写入）
 */

/**
 * 命令规则（插件 `rule` 数组的单项）。
 *
 * @typedef {object} RuleDecl
 * @property {RegExp} reg 命令正则
 * @property {string} fnc 处理方法名
 * @property {string} [event] 事件声明（如 `message.group.normal`）
 * @property {"master"|"admin"|"owner"} [permission] 权限要求
 * @property {boolean} [log] 传 `false` 则日志降级为 debug
 */

/**
 * 插件加载器给出的调度条目：一个插件声明 + 它的类。
 *
 * 字段故意写成 `Record<string, unknown>` 而不是精确结构——插件声明是用户代码，
 * 类型上只能收窄到"可按下标取字段"。真正的字段校验归 `lib/plugins/metadata.js`。
 *
 * @typedef {object} PluginEntry
 * @property {Record<string, unknown>} plugin 插件声明（`name` / `rule` / `accept` / `event` / `getContext` …）
 * @property {new (...args: unknown[]) => Record<string, unknown>} class 插件类
 */

/**
 * 流水线需要的加载器接口（结构类型，单测可传替身）。
 *
 * @typedef {object} PluginLoader
 * @property {PluginEntry[]} priority 按 `priority` 排好序的插件列表
 * @property {(event: Record<string, unknown>, type: string, msg: unknown) => Promise<unknown>} count 计数
 */

/**
 * 流水线需要的 runtime 接口。只用到 `init()`，其余方法由插件自行调用。
 *
 * @typedef {object} Runtime
 * @property {(event: Record<string, unknown>) => Promise<void>} [init]
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
   * @param {PluginLoader} opts.loader 插件加载器（阶段通过它访问插件列表与计数服务）
   * @param {string} opts.profileKey 配置档案标识（当前为 bot 账号 `self_id`）
   * @param {object} opts.cfg 宿主配置对象（即 `lib/config/config.js`）
   *   阶段**不得**自行 `import` 配置文件——从上下文取才能被单测注入替身
   * @param {Runtime} [opts.runtime] 插件 runtime（即 `lib/plugins/runtime.js`）
   *   同样由外部注入：该模块会静态引入 puppeteer 等重依赖，阶段直接 import 会让单测难以隔离
   */
  constructor({ loader, profileKey, cfg, runtime }) {
    this.loader = loader
    this.profileKey = profileKey
    this.cfg = cfg
    this.runtime = runtime ?? null
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
      state = { stopped: false, groupCfg: null, priority: null }
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
