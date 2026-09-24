import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { PipelineContext } from "../../../lib/pipeline/context.js"
import { PipelineScheduler, processStages } from "../../../lib/pipeline/scheduler.js"
import { clearRegisteredStages, registerStage, Stage } from "../../../lib/pipeline/stage.js"
import { STAGES_ORDER, assertStageCoverage } from "../../../lib/pipeline/stage-order.js"

/** 调用轨迹，测试之间清空 */
let trace = []

/**
 * 把阶段类的名字改成指定值，以便与 `STAGES_ORDER` 对齐。
 * @param {Function} cls 阶段类
 * @param {string} name 目标名字
 * @returns {Function} 同一个类
 */
function rename(cls, name) {
  Object.defineProperty(cls, "name", { value: name })
  return cls
}

/**
 * 造一个普通阶段。
 *
 * @param {string} name 阶段名
 * @param {(ctx: PipelineContext, event: object) => unknown} [fn] 额外行为
 * @returns {Function} 阶段类
 */
function plain(name, fn) {
  return rename(
    class extends Stage {
      async process(event) {
        trace.push(`pre:${name}`)
        await fn?.(this.ctx, event)
      }
    },
    name,
  )
}

/**
 * 造一个**返回异步生成器**的阶段——即已废弃的洋葱写法，用于验证会被显式拒绝。
 * @param {string} name 阶段名
 * @returns {Function} 阶段类
 */
function legacyOnion(name) {
  return rename(
    class extends Stage {
      // 刻意不写 yield：这就是"已废弃的洋葱写法"本身，用于验证调度器会把它变成显式错误
      // eslint-disable-next-line require-yield
      async *process() {
        trace.push(`pre:${name}`)
      }
    },
    name,
  )
}

/**
 * 按 `STAGES_ORDER` 注册一整套阶段，可用 `overrides` 替换其中若干个。
 * @param {Record<string, Function>} [overrides] 按名字替换
 * @returns {void}
 */
function registerAll(overrides = {}) {
  for (const name of STAGES_ORDER) registerStage(overrides[name] ?? plain(name))
}

/**
 * 造一个干净的上下文。
 * @returns {PipelineContext} 上下文
 */
function makeContext() {
  return new PipelineContext({ loader: { priority: [] }, profileKey: "test", cfg: {} })
}

/**
 * 用一组阶段**类**跑一次（负责实例化与初始化）。
 * @param {Array<Function>} stageClasses 阶段类
 * @returns {Promise<{ ctx: PipelineContext, event: object }>} 上下文与事件
 */
async function runStages(stageClasses) {
  const ctx = makeContext()
  for (const StageClass of stageClasses) {
    const stage = new StageClass()
    await stage.initialize(ctx)
    ctx.stages.push(stage)
  }
  const event = {}
  await processStages(ctx, event, 0)
  return { ctx, event }
}

beforeEach(() => {
  trace = []
  clearRegisteredStages()
})

afterEach(() => {
  clearRegisteredStages()
})

describe("assertStageCoverage", () => {
  it("注册表与 STAGES_ORDER 完全一致时通过", () => {
    registerAll()
    expect(() => assertStageCoverage()).not.toThrow()
  })

  it("缺少注册时抛错并指出名字", () => {
    const missing = STAGES_ORDER[4]
    for (const name of STAGES_ORDER) if (name !== missing) registerStage(plain(name))

    expect(() => assertStageCoverage()).toThrow(/缺少注册/)
    expect(() => assertStageCoverage()).toThrow(new RegExp(missing))
  })

  it("STAGES_ORDER 未声明的阶段同样抛错（不允许绕过顺序声明）", () => {
    registerAll()
    registerStage(plain("SurpriseStage"))

    expect(() => assertStageCoverage()).toThrow(/STAGES_ORDER 未声明/)
    expect(() => assertStageCoverage()).toThrow(/SurpriseStage/)
  })

  it("重复注册抛错", () => {
    const cls = plain("StatisticsStage")
    registerStage(cls)
    expect(() => registerStage(cls)).toThrow(/重复注册/)
  })

  it("基类的 process() 会抛错，避免漏实现被静默忽略", () => {
    expect(() => new Stage().process({})).toThrow(/未实现 process/)
  })
})

describe("processStages：执行顺序", () => {
  it("严格按 STAGES_ORDER 顺序执行，每个阶段恰好一次", async () => {
    registerAll()
    const ctx = makeContext()
    await new PipelineScheduler(ctx).initialize()

    await new PipelineScheduler(ctx).execute({})

    expect(trace).toEqual(STAGES_ORDER.map(name => `pre:${name}`))
  })

  it("阶段实例只初始化一次并被复用（有状态阶段依赖这一点）", async () => {
    registerAll()
    const ctx = makeContext()
    await new PipelineScheduler(ctx).initialize()

    expect(ctx.stages).toHaveLength(STAGES_ORDER.length)
    const first = ctx.stages[0]
    const scheduler = new PipelineScheduler(ctx)
    await scheduler.execute({})
    await scheduler.execute({})
    expect(ctx.stages[0]).toBe(first)
    expect(trace).toHaveLength(STAGES_ORDER.length * 2)
  })

  it("`from` 参数可跳过前面的阶段", async () => {
    const ctx = makeContext()
    ctx.stages = [new (plain("A"))(), new (plain("B"))(), new (plain("C"))()]

    await processStages(ctx, {}, 1)
    expect(trace).toEqual(["pre:B", "pre:C"])
  })

  it("空阶段列表直接返回，不抛错", async () => {
    await expect(processStages(makeContext(), {}, 0)).resolves.toBeUndefined()
  })
})

describe("processStages：中断传播", () => {
  it("某个阶段 stop 之后，下游不再执行", async () => {
    const { ctx, event } = await runStages([
      plain("A"),
      plain("B", (c, e) => c.stop(e)),
      plain("C"),
    ])
    expect(trace).toEqual(["pre:A", "pre:B"])
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("第一个阶段就 stop 时，后面的全部不执行", async () => {
    await runStages([plain("A", (c, e) => c.stop(e)), plain("B")])
    expect(trace).toEqual(["pre:A"])
  })

  it("stop 只影响当前事件，不影响后续事件", async () => {
    const ctx = makeContext()
    ctx.stages = [new (plain("A", (c, e) => c.stop(e)))(), new (plain("B"))()]
    for (const stage of ctx.stages) stage.ctx = ctx

    const first = {}
    await processStages(ctx, first, 0)
    expect(trace).toEqual(["pre:A"])

    trace = []
    await processStages(ctx, {}, 0)
    expect(trace).toEqual(["pre:A"])
  })
})

describe("processStages：拒绝已废弃的洋葱写法", () => {
  it("阶段返回异步生成器时显式抛错，而不是静默什么都不做", async () => {
    // 若不做这个检查：await 一个生成器不会执行它的函数体，表现为"该阶段无效果"，
    // 排查成本极高。所以把误用变成显式错误。
    await expect(runStages([legacyOnion("Legacy")])).rejects.toThrow(/洋葱模型已被否决/)
    expect(trace).toEqual([])
  })

  it("错误信息里包含阶段名，便于定位", async () => {
    await expect(runStages([legacyOnion("Legacy")])).rejects.toThrow(/Legacy/)
  })
})

describe("PipelineContext：每事件状态", () => {
  it("状态挂在不可枚举的 Symbol 键上，不污染 e 的可见字段", () => {
    const ctx = makeContext()
    const event = { msg: "hi" }
    ctx.stateOf(event)

    expect(Object.keys(event)).toEqual(["msg"])
    expect(JSON.stringify(event)).toBe('{"msg":"hi"}')
    // Object.assign 会复制**可枚举**的 Symbol 属性，所以必须显式设 enumerable: false
    expect(Object.getOwnPropertySymbols(Object.assign({}, event))).toEqual([])
  })

  it("不同事件的状态互不影响", () => {
    const ctx = makeContext()
    const a = {}
    const b = {}
    ctx.stop(a)
    expect(ctx.isStopped(a)).toBe(true)
    expect(ctx.isStopped(b)).toBe(false)
  })

  it("未创建状态的事件 isStopped 为 false（不抛错）", () => {
    expect(makeContext().isStopped({})).toBe(false)
  })

  it("状态随事件走：同一事件下不同上下文的 stopped 是同一个值", () => {
    // 每条事件只属于一个配置档案，因此 stopped 天然不需要按上下文隔离；
    // 真正需要按档案隔离的是限流计数之类的**阶段实例状态**，见下一条用例。
    const ctx = makeContext()
    const event = {}
    ctx.stop(event)
    expect(makeContext().isStopped(event)).toBe(true)
  })

  it("状态可被后续阶段读取（会话变量的雏形）", () => {
    const ctx = makeContext()
    const event = {}
    ctx.stateOf(event).groupCfg = { onlyReplyAt: 0 }
    expect(ctx.stateOf(event).groupCfg).toEqual({ onlyReplyAt: 0 })
  })

  it("阶段实例是每个上下文独立的（这才是限流计数隔离的机制）", async () => {
    registerAll()
    const ctxA = makeContext()
    const ctxB = makeContext()
    await new PipelineScheduler(ctxA).initialize()
    await new PipelineScheduler(ctxB).initialize()

    expect(ctxA.stages).toHaveLength(STAGES_ORDER.length)
    expect(ctxB.stages).toHaveLength(STAGES_ORDER.length)
    expect(ctxA.stages[0]).not.toBe(ctxB.stages[0])
  })
})
