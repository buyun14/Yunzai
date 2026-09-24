import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import cfg from "../../../lib/config/config.js"
import { PipelineContext } from "../../../lib/pipeline/context.js"
import { PipelineScheduler } from "../../../lib/pipeline/scheduler.js"
import { makeEvent } from "../../helpers/events.js"
import { SCENARIOS } from "./shadow-scenarios.js"

/**
 * 场景表回归：每条事件跑一遍**真实流水线**，与冻结的基线逐项比对。
 *
 * # 这个文件曾经叫「影子运行」
 *
 * `SCENARIOS` 表与这里的观测量，本来是阶段 2 的「影子对比」用的：同一条事件分别走
 * 旧 `PluginsLoader.deal()` 与新流水线，逐项比较，作为「零行为变化」的证据。
 * 阶段 2 第 5 步删掉了旧路径，对比无法再做——但**那张表和那些观测量依然有用**：
 * 对比的结论已经被冻结成基线（见下方「基线对照」），而这些用例仍在跑真实流水线。
 *
 * # 为什么比较「观测快照」而不是内部状态
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
 * 1. **每次都用事件副本**：`ProcessStage` 的 `Object.defineProperty(e, "isSr", …)` 不可重入，
 *    且阶段会就地包装 `e.reply`。
 * 2. **每次都用新的 `PipelineContext`**：冷却表挂在阶段实例上，会被前一个用例污染。
 */

// Runtime.init 会静态拉入 puppeteer，对行为比较没有意义
vi.mock("../../../lib/plugins/runtime.js", () => ({ default: { init: async () => {} } }))

/**
 * 跑真实流水线（装配方式与启动路径相同）。
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
 * 场景表沿用了改造前的写法：只覆盖 `cfg.getGroup()` / `cfg.getOther()` 两个方法，
 * 不去动宿主配置模块本身（它是个单例，改了会影响别的用例）。
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

describe("场景表：真实流水线的行为", () => {
  it("场景表覆盖到每一类决策，且用例名唯一", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30)
    expect(new Set(SCENARIOS.map(s => s.name)).size).toBe(SCENARIOS.length)
  })

  /**
   * 按名字取场景。写错名字直接报错，而不是让用例空转。
   *
   * @param {string} name 场景名
   * @returns {import("./shadow-scenarios.js").Scenario} 场景
   */
  const find = name => {
    const found = SCENARIOS.find(s => s.name === name)
    if (!found) throw new Error(`场景不存在：${name}`)
    return found
  }

  it("确实有场景执行了插件处理器", async () => {
    expect((await runPipeline(find("rule 命中并执行处理器"))).invoked).toContain("复读机.onMsg")
  })

  it("context hook 被调用两次", async () => {
    /**
     * @param {Record<string, unknown>} snap 快照
     * @returns {number} 调用次数
     */
    const twice = snap =>
      /** @type {string[]} */ (snap.invoked).filter(l => l === "钩子.getContext").length

    expect(twice(await runPipeline(find("context hook 返回 continue 时放行")))).toBe(2)
  })

  it("断言对配置敏感：换掉黑名单结果就不同", async () => {
    const base = find("黑名单用户被拦截")
    const blocked = await runPipeline(base)
    const allowed = await runPipeline({ ...base, cfg: { other: { blackUser: [99999] } } })

    expect(blocked.invoked).toEqual([])
    expect(allowed.invoked).toContain("复读机.onMsg")
  })

  it("每次都用新上下文，冷却表不残留", async () => {
    const scenario = find("群冷却生效时拦截")
    expect(await runPipeline(scenario)).toEqual(await runPipeline(scenario))
  })

  it("场景表不是退化断言：确实有场景走到了插件执行与发送", async () => {
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

/**
 * 基线对照：流水线必须与冻结下来的基线逐项一致。
 *
 * # 基线的来历
 *
 * 阶段 2 做影子对比时（旧 `deal()` 与新流水线逐项比），把**经两侧互证过**的旧侧结果
 * 录成了 fixture——那是当时唯一能拿到“正确行为”的途径。阶段 2 第 5 步删掉旧路径后，
 * 这份 JSON 就成了那条已验证行为的**唯一书面依据**：没有它，以后没人能确认现在是对的。
 *
 * 也正因为如此，录制从“抄一份旧实现的结果”变成了“接受当前的输出”——
 * 它不再能自证正确。所以录制必须显式设 `RECORD_BASELINE=1`，
 * 且提交前要逐行看清 JSON 的差异：那些差异就是行为变更本身。
 *
 * 比对前都过一遍 JSON：基线里存的是 JSON，`undefined` 会被丢掉，
 * 不过这一道会让“值为 undefined 的字段”在两边表现不一而假装相等。
 */
describe("基线对照：与冻结的基线一致", () => {
  const BASELINE_FILE = fileURLToPath(
    new URL("../../fixtures/pipeline/baseline-snapshots.json", import.meta.url),
  )

  /** JSON 化：把 `undefined` 统一成 `null`，让两边可比 */
  const plain = value => JSON.parse(JSON.stringify(value ?? null))

  it("基线里覆盖了全部场景（新增场景时得重录）", async () => {
    const baseline = JSON.parse(await fs.readFile(BASELINE_FILE, "utf8"))
    const missing = SCENARIOS.filter(scenario => !(scenario.name in baseline)).map(s => s.name)

    expect(
      missing,
      `这些场景不在基线里，请用 RECORD_BASELINE=1 重录并审阅 diff：\n${missing.join("\n")}`,
    ).toEqual([])
  })

  for (const scenario of SCENARIOS)
    it(scenario.name, async () => {
      const baseline = JSON.parse(await fs.readFile(BASELINE_FILE, "utf8"))
      expect(plain(await runPipeline(scenario))).toEqual(plain(baseline[scenario.name]))
    })
})

describe("基线快照：录制", () => {
  it("RECORD_BASELINE=1 时把当前流水线的结果写成基线快照", async () => {
    if (!process.env.RECORD_BASELINE) return

    /** @type {Record<string, unknown>} */
    const snapshots = {}
    for (const scenario of SCENARIOS) snapshots[scenario.name] = await runPipeline(scenario)

    const file = fileURLToPath(
      new URL("../../fixtures/pipeline/baseline-snapshots.json", import.meta.url),
    )
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify(snapshots, null, 2)}\n`)
    console.log(`[记录] ${Object.keys(snapshots).length} 个场景 → ${file}`)
  })
})
