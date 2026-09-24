import { PipelineContext } from "../../lib/pipeline/context.js"

/**
 * 流水线阶段的测试脚手架。
 *
 * 阶段测试的共同需求是「造上下文 → 按顺序初始化 → 跑一条事件 → 断言是否被拦」。
 * 这里把这套动作收拢，避免每个测试文件重复拼装。
 */

/**
 * 造一个加载器替身。
 *
 * @param {Array<object>} [entries] `priority` 列表（由 `makePluginEntry` 生成）
 * @returns {{ priority: Array<object>, counted: Array<{ type: string, msg: unknown }>, count: Function }}
 *   替身对象
 */
export function createLoaderStub(entries = []) {
  /** @type {Array<{ type: string, msg: unknown }>} */
  const counted = []
  return {
    priority: entries,
    counted,
    /**
     * 记录一次计数。
     * @param {unknown} event 事件对象
     * @param {string} type 计数类型
     * @param {unknown} msg 计数内容
     * @returns {Promise<void>} 无
     */
    async count(event, type, msg) {
      counted.push({ type, msg })
    },
  }
}

/**
 * 造一个调度条目（`loader.priority` 的成员）。
 *
 * **形状必须与 `PluginsLoader.addPlugin()` 一致**：`plugin` 是插件**实例**，
 * `class` 是它的**构造器**。这不是随便定的——`deal()` 里
 * `Object.assign(new i.class(e), { e }).accept(e)` 说明每次调用都会**新建实例**，
 * 而筛选阶段读的是常驻的那个 `plugin` 实例上的 `rule` / `event` / `accept`。
 * 如果这里把 `plugin` 造成"声明对象"，`accept` / `getContext` 这类方法就取不到，
 * 测试会偏离真实行为。
 *
 * `event` 默认给 `"message.*.*"`：真实插件**必须**声明 `event`，
 * 否则会被 `matchesEvent` 排除（对应 `filtEvent` 的 `if (!v.event) return false`）。
 * 测试只在"声明本身是断言对象"时才需要显式给出。
 *
 * 函数值一律挂到原型（对应插件类里的方法），其余作为实例字段。
 *
 * @param {string} name 插件名（就是 `plugin.name`，用于 `disable` / `enable` 匹配）
 * @param {object} [decl] 字段（`rule` / `event` / `permission` …）与方法（`accept` / `getContext` …）
 * @param {object} [proto] 额外的原型方法
 * @returns {{ plugin: Record<string, unknown>, class: new (...args: unknown[]) => object }} 调度条目
 */
export function makePluginEntry(name, decl = {}, proto = {}) {
  /** @type {Record<string, unknown>} */
  const data = {}
  /** @type {Record<string, unknown>} */
  const methods = { ...proto }
  for (const [key, value] of Object.entries(decl)) {
    if (typeof value === "function") methods[key] = value
    else data[key] = value
  }

  class Plugin {}
  // `name` 挂在原型上：真实插件在构造函数里 `this.name = ...`，
  // 因此 `new i.class(e)` 出来的**新实例**同样带 name（`deal()` 会读它拼日志前缀）。
  // 只挂在预建实例上会让新实例拿不到，测试就会偏离真实行为。
  Plugin.prototype.name = name
  Object.assign(Plugin.prototype, methods)

  const plugin = new Plugin()
  Object.assign(plugin, { event: "message.*.*" }, data)

  return { plugin, class: Plugin }
}

/**
 * 按给定顺序初始化一组阶段，返回可用的上下文。
 *
 * 顺序必须与 `STAGES_ORDER` 一致——`RateLimitCommitStage` 等阶段依赖前序阶段
 * 已经完成初始化。这里刻意**不**调用 `assertStageCoverage`：
 * 单测只装配自己关心的阶段子集。
 *
 * @param {Array<new () => import("../../lib/pipeline/stage.js").Stage>} StageClasses 阶段类
 * @param {{ cfg?: object, loader?: object, runtime?: object }} [deps] 依赖替身
 * @returns {Promise<{ ctx: PipelineContext, stages: Array<object> }>} 上下文与已初始化的阶段
 */
export async function setupPipeline(StageClasses, deps = {}) {
  const ctx = new PipelineContext({
    loader: deps.loader ?? createLoaderStub(),
    profileKey: "test",
    cfg: deps.cfg ?? {},
    runtime: deps.runtime,
  })

  /** @type {Array<object>} */
  const stages = []
  for (const StageClass of StageClasses) {
    const stage = new StageClass()
    await stage.initialize(ctx)
    ctx.stages.push(stage)
    stages.push(stage)
  }

  return { ctx, stages }
}
