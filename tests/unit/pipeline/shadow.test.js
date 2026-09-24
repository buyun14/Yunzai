import { describe, expect, it, vi } from "vitest"
import cfg from "../../../lib/config/config.js"
import { PipelineContext } from "../../../lib/pipeline/context.js"
import { PipelineScheduler } from "../../../lib/pipeline/scheduler.js"
import { PluginsLoader } from "../../../lib/plugins/loader.js"
import { makeEvent } from "../../helpers/events.js"
import { SCENARIOS } from "./shadow-scenarios.js"

/**
 * 影子运行：同一条事件分别走**旧 `deal()`** 与**新流水线**，逐项比较可观测结果。
 *
 * # 为什么两侧都要跑真实实现
 *
 * 新流水线的 `dispatch.js` 刻意**没有**复用 `PluginsLoader` 的任何方法。
 * 如果两边共享实现，对比只能证明“代码相同”，不能证明“行为相同”。
 * 同理这里也不 mock 任何一侧——两侧都跑真实代码路径，只替身化外部依赖
 * （`Runtime.init` 会拉 puppeteer，与比较无关）。
 *
 * # 只比较「可观测结果」，不比较内部停在哪一步
 *
 * 旧 `deal()` 是一个一百多行的过程式函数，无法从外部观察它内部的 `return`。
 * 但所有分支的**后果**都是可观测的：
 *
 * | 观测量 | 覆盖的决策点 |
 * |---|---|
 * | `invoked` 方法调用序列 | 黑白名单、禁言、限流、唤醒门槛、`getContext`、`accept`、`rule` 匹配、权限 |
 * | `sent` 发出的消息 | 权限不足提示、插件自己发的内容 |
 * | `counts` 计数调用 | 统计与发送计数（顺带证明“是否走到发送”） |
 * | 归一化字段 | `msg` / `game` / `only_reply_at` / `isGroup` / `hasAlias` / `logText` 等 |
 *
 * # 两条硬约束
 *
 * 1. **必须用事件副本**：`ProcessStage` 的 `Object.defineProperty(e, "isSr", …)` 不可重入，
 *    且两侧都会就地包装 `e.reply`。
 * 2. **必须用新的 `PluginsLoader` 实例**：模块默认导出是单例，
 *    它的 `groupCD` / `msgThrottle` 会被前一个用例污染。
 */

// Runtime.init 会静态拉入 puppeteer，对行为比较没有意义
vi.mock("../../../lib/plugins/runtime.js", () => ({ default: { init: async () => {} } }))

/**
 * 旧侧：跑真实 `PluginsLoader.deal()`。
 *
 * @param {import("./shadow-scenarios.js").Scenario} scenario 场景
 * @returns {Promise<Record<string, unknown>>} 观测快照
 */
async function runLegacy(scenario) {
  const invoked = []
  const counts = []
  const loader = new PluginsLoader()

  loader.priority = scenario.build?.(label => invoked.push(label)) ?? []
  loader.count = async (e, type, msg) => {
    counts.push({ type, msg })
  }
  Object.assign(loader, scenario.seed)

  const { event, sent } = makeEvent(scenario.fixture, scenario.overrides)
  await withCfg(scenario.cfg, () => loader.deal(event))

  return snapshot(event, sent, counts, invoked)
}

/**
 * 新侧：跑真实流水线（走 `bootstrapPipeline()`，与启动路径相同）。
 *
 * @param {import("./shadow-scenarios.js").Scenario} scenario 场景
 * @returns {Promise<Record<string, unknown>>} 观测快照
 */
async function runPipeline(scenario) {
  const invoked = []
  const counts = []
  const loader = {
    priority: scenario.build?.(label => invoked.push(label)) ?? [],
    count: async (e, type, msg) => {
      counts.push({ type, msg })
    },
  }

  const ctx = new PipelineContext({
    loader,
    profileKey: "shadow",
    cfg,
    runtime: { init: async () => {} },
  })
  const scheduler = new PipelineScheduler(ctx)
  await scheduler.initialize()

  // 冷却表在阶段实例上，预置状态要挂到真正的持有者
  for (const [key, value] of Object.entries(scenario.seed ?? {}))
    Object.assign(stageOf(ctx, key), { [key]: value })

  const { event, sent } = makeEvent(scenario.fixture, scenario.overrides)
  await withCfg(scenario.cfg, () => scheduler.execute(event))

  return snapshot(event, sent, counts, invoked)
}

/**
 * 找到持有某个限流状态的阶段。写错名字时直接报错，而不是默默不预置。
 *
 * @param {import("../../../lib/pipeline/context.js").PipelineContext} ctx 上下文
 * @param {string} key 状态名（`groupCD` / `singleCD` / `msgThrottle`）
 * @returns {Record<string, unknown>} 持有该状态的阶段
 */
function stageOf(ctx, key) {
  const stage = ctx.stages.find(holder => key in holder)
  if (!stage) throw new Error(`没有任何阶段持有状态 ${key}，场景预置写错了`)
  return /** @type {Record<string, unknown>} */ (stage)
}

/**
 * 在给定配置下执行，结束后恢复。
 *
 * 两侧用的是**同一个** `cfg` 对象（`loader.js` 里静态 import 的模块单例），
 * 因此覆盖是共享的、天然的——这也是这里能用真实 `deal()` 的前提。
 *
 * @param {{ group?: object, other?: object }} [config] 覆盖项
 * @param {() => Promise<void>} run 待执行的动作
 * @returns {Promise<void>} 无
 */
async function withCfg(config = {}, run) {
  const realGetGroup = cfg.getGroup
  const realGetOther = cfg.getOther

  cfg.getGroup = () => ({ ...GROUP_DEFAULTS, ...config.group })
  cfg.getOther = () => ({ ...OTHER_DEFAULTS, ...config.other })

  try {
    await run()
  } finally {
    cfg.getGroup = realGetGroup
    cfg.getOther = realGetOther
  }
}

/** 与 `config/default_config/group.yaml` 的 `default` 段一致 */
const GROUP_DEFAULTS = {
  groupCD: 500,
  singleCD: 2000,
  onlyReplyAt: 0,
  botAlias: ["云崽", "云宝"],
  disable: [],
  enable: undefined,
}

/** 与 `config/default_config/other.yaml` 一致 */
const OTHER_DEFAULTS = {
  whiteGroup: [],
  whiteUser: [],
  blackGroup: [],
  blackUser: [],
}

/**
 * 抽出一份可比较的观测快照。
 *
 * 只取**决定性的**字段，避免把无关的噪声（时间戳、函数引用）带进对比。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @param {unknown[]} sent 发出的消息
 * @param {unknown[]} counts 计数调用
 * @param {unknown[]} invoked 方法调用序列
 * @returns {Record<string, unknown>} 快照
 */
function snapshot(event, sent, counts, invoked) {
  return {
    invoked,
    sent,
    counts,
    msg: event.msg,
    game: event.game,
    at: event.at,
    atBot: event.atBot,
    img: event.img,
    file: event.file,
    reply_id: event.reply_id,
    isGroup: event.isGroup,
    isPrivate: event.isPrivate,
    isMaster: event.isMaster,
    hasAlias: event.hasAlias,
    only_reply_at: event.only_reply_at,
    logFnc: event.logFnc,
    logText: event.logText,
  }
}

/**
 * 逐字段断言两侧一致。
 *
 * @param {import("./shadow-scenarios.js").Scenario} scenario 场景
 * @returns {Promise<Record<string, unknown>>} 新侧快照，便于用例补充断言
 */
async function expectSame(scenario) {
  const legacy = await runLegacy(scenario)
  const pipeline = await runPipeline(scenario)

  for (const key of Object.keys(legacy))
    expect(pipeline[key], `场景「${scenario.name}」的 ${key} 不一致`).toEqual(legacy[key])

  return pipeline
}

describe("影子运行：旧 deal() 与新流水线逐项对比", () => {
  it("场景表覆盖到每一类决策，且用例名唯一", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30)
    expect(new Set(SCENARIOS.map(s => s.name)).size).toBe(SCENARIOS.length)
  })

  for (const scenario of SCENARIOS)
    it(scenario.name, async () => {
      await expectSame(scenario)
    })
})

describe("影子运行：对比本身是有效的（防止假阳性）", () => {
  /**
   * @param {string} name 场景名
   * @returns {import("./shadow-scenarios.js").Scenario} 场景
   */
  const find = name => {
    const found = SCENARIOS.find(s => s.name === name)
    if (!found) throw new Error(`场景不存在：${name}`)
    return found
  }

  it("两侧都真的执行了插件处理器", async () => {
    const scenario = find("rule 命中并执行处理器")
    expect((await runLegacy(scenario)).invoked).toContain("复读机.onMsg")
    expect((await runPipeline(scenario)).invoked).toContain("复读机.onMsg")
  })

  it("两侧都真的调用了 getContext 两次", async () => {
    const scenario = find("context hook 返回 continue 时放行")
    /**
     * @param {Record<string, unknown>} snap 快照
     * @returns {number} 调用次数
     */
    const twice = snap =>
      /** @type {string[]} */ (snap.invoked).filter(l => l === "钩子.getContext").length
    expect(twice(await runLegacy(scenario))).toBe(2)
    expect(twice(await runPipeline(scenario))).toBe(2)
  })

  it("对比对配置敏感：换掉黑名单结果就不同", async () => {
    const base = find("黑名单用户被拦截")
    const blocked = await runLegacy(base)
    const allowed = await runLegacy({ ...base, cfg: { other: { blackUser: [99999] } } })

    expect(blocked.invoked).toEqual([])
    expect(allowed.invoked).toContain("复读机.onMsg")
  })

  it("旧侧每次都用新实例，限流表不会被上一次运行污染", async () => {
    const scenario = find("同文去重生效时拦截")
    expect(await runLegacy(scenario)).toEqual(await runLegacy(scenario))
  })

  it("流水线侧每次都用新上下文，冷却表同样不残留", async () => {
    const scenario = find("群冷却生效时拦截")
    expect(await runPipeline(scenario)).toEqual(await runPipeline(scenario))
  })

  it("场景表不是退化对比：确实有场景走到了插件执行与发送", async () => {
    /** @type {Array<Record<string, unknown>>} */
    const snapshots = []
    for (const scenario of SCENARIOS) snapshots.push(await runPipeline(scenario))

    // 若所有场景都在第一步就 return，`invoked` 会全空、"对比通过"将毫无意义
    const executed = snapshots.filter(s =>
      /** @type {string[]} */ (s.invoked).some(label => /\.(onMsg|first|second)$/.test(label)),
    )
    const sent = snapshots.filter(s => /** @type {unknown[]} */ (s.sent).length > 0)
    const counted = snapshots.filter(s =>
      /** @type {Array<{ type: string }>} */ (s.counts).some(c => c.type === "receive"),
    )

    expect(executed.length).toBeGreaterThanOrEqual(8)
    expect(sent.length).toBeGreaterThanOrEqual(3)
    expect(counted.length).toBeGreaterThanOrEqual(30)
  })

  it("插件筛选类场景会产生不同的 priority（不是全量放行）", async () => {
    const executedLabels = async scenario =>
      (await runPipeline(scenario)).invoked.filter(l => !l.endsWith(".getContext"))

    expect(await executedLabels(find("disable 命中的插件被排除"))).toEqual([])
    expect(await executedLabels(find("没有 event 声明的插件被排除"))).toEqual([])
    expect(await executedLabels(find("rule 命中并执行处理器"))).toContain("复读机.onMsg")
  })
})
