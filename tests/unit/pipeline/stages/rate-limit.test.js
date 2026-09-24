import { afterEach, describe, expect, it, vi } from "vitest"
import { RateLimitCheckStage } from "../../../../lib/pipeline/stages/rate-limit-check.js"
import { RateLimitCommitStage } from "../../../../lib/pipeline/stages/rate-limit-commit.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { setupPipeline } from "../../../helpers/pipeline.js"

/**
 * 装配「检查 + 提交」两个阶段（顺序与 `STAGES_ORDER` 一致）。
 *
 * @param {object} [cfgOverrides] 配置覆盖项
 * @returns {Promise<{ ctx: object, check: object, commit: object }>} 上下文与阶段实例
 */
async function setup(cfgOverrides = {}) {
  const { ctx, stages } = await setupPipeline([RateLimitCheckStage, RateLimitCommitStage], {
    cfg: createConfigStub(cfgOverrides),
  })
  return { ctx, check: stages[0], commit: stages[1] }
}

/**
 * 造一条事件并跑完两个阶段。
 *
 * @param {string} name 样本名
 * @param {{ overrides?: object, state?: (event: object) => void }} [opts] 选项
 * @param {{ ctx: object, check: object, commit: object }} pipeline 已装配的流水线
 * @returns {Promise<object>} 事件对象
 */
async function run(name, opts, pipeline) {
  const { event } = makeEvent(name, opts.overrides)
  opts.state?.(event)
  await pipeline.check.process(event)
  if (!pipeline.ctx.isStopped(event)) await pipeline.commit.process(event)
  return event
}

afterEach(() => {
  vi.useRealTimers()
})

describe("RateLimitCheckStage：禁言", () => {
  it("群被禁言（mute_left > 0）时拦截", async () => {
    const pipeline = await setup()
    const event = await run("group-command", { overrides: { group: { mute_left: 60 } } }, pipeline)
    expect(pipeline.ctx.isStopped(event)).toBe(true)
  })

  it("全员禁言且发言者既非管理也非群主时拦截", async () => {
    const pipeline = await setup()
    const event = await run(
      "group-command",
      { overrides: { group: { mute_left: 0, all_muted: true, is_admin: false, is_owner: false } } },
      pipeline,
    )
    expect(pipeline.ctx.isStopped(event)).toBe(true)
  })

  it("全员禁言但发言者是管理员时放行", async () => {
    const pipeline = await setup()
    const event = await run(
      "group-command",
      { overrides: { group: { mute_left: 0, all_muted: true, is_admin: true } } },
      pipeline,
    )
    expect(pipeline.ctx.isStopped(event)).toBe(false)
  })

  it("全员禁言但发言者是群主时放行", async () => {
    const pipeline = await setup()
    const event = await run(
      "group-command",
      { overrides: { group: { mute_left: 0, all_muted: true, is_owner: true } } },
      pipeline,
    )
    expect(pipeline.ctx.isStopped(event)).toBe(false)
  })

  it("禁言判定先于冷却——禁言时不会写冷却表", async () => {
    const pipeline = await setup()
    const event = await run("group-command", { overrides: { group: { mute_left: 60 } } }, pipeline)
    expect(pipeline.ctx.isStopped(event)).toBe(true)
    expect(pipeline.check.msgThrottle).toEqual({})
  })
})

describe("RateLimitCheckStage：消息内容门槛", () => {
  it("无 message 数组时早退（不参与限流）", async () => {
    const pipeline = await setup()
    const event = await run("group-command", { overrides: { message: undefined } }, pipeline)
    expect(pipeline.ctx.isStopped(event)).toBe(false)
    expect(pipeline.check.msgThrottle).toEqual({})
  })

  it("私聊消息不会在 isPrivate 分支早退（该字段此时尚未赋值）", async () => {
    const pipeline = await setup()
    const event = await run("private-command", {}, pipeline)
    expect(event.isPrivate).toBeUndefined()
    // 因此仍然写进了去重表——与旧实现一致
    expect(Object.keys(pipeline.check.msgThrottle)).toHaveLength(1)
  })
})

describe("RateLimitCheckStage：同文去重", () => {
  it("1 秒内重复的同一用户同条消息被拦截", async () => {
    const pipeline = await setup()
    const overrides = { user_id: 10001, raw_message: "重复内容" }
    const first = await run("group-command", { overrides }, pipeline)
    const second = await run("group-command", { overrides }, pipeline)

    expect(pipeline.ctx.isStopped(first)).toBe(false)
    expect(pipeline.ctx.isStopped(second)).toBe(true)
  })

  it("不同用户发同一条消息不被拦截（去重键含 user_id）", async () => {
    const pipeline = await setup()
    const first = await run(
      "group-command",
      { overrides: { user_id: 10001, raw_message: "同文" } },
      pipeline,
    )
    const second = await run(
      "group-command",
      { overrides: { user_id: 10002, raw_message: "同文" } },
      pipeline,
    )

    expect(pipeline.ctx.isStopped(first)).toBe(false)
    expect(pipeline.ctx.isStopped(second)).toBe(false)
  })

  it("去重键含 self_id——同一群两个 bot 账号互不干扰", async () => {
    const pipeline = await setup()
    const overrides = { raw_message: "同文", user_id: 10001 }
    await run("group-command", { overrides }, pipeline)
    const other = await run(
      "group-command",
      { overrides: { ...overrides, self_id: 54321 } },
      pipeline,
    )

    expect(pipeline.ctx.isStopped(other)).toBe(false)
  })

  it("超过 1 秒后放行", async () => {
    vi.useFakeTimers()
    const pipeline = await setup()
    const overrides = { raw_message: "同文" }

    await run("group-command", { overrides }, pipeline)
    expect(pipeline.check.msgThrottle).not.toEqual({})

    await vi.advanceTimersByTimeAsync(1100)
    expect(pipeline.check.msgThrottle).toEqual({})

    const again = await run("group-command", { overrides }, pipeline)
    expect(pipeline.ctx.isStopped(again)).toBe(false)
  })
})

describe("RateLimitCheckStage + CommitStage：冷却", () => {
  it("检查阶段不写冷却表（提交由 commit 阶段负责）", async () => {
    const pipeline = await setup()
    const { event } = makeEvent("group-command", { only_reply_at: 1 })
    await pipeline.check.process(event)

    expect(pipeline.ctx.isStopped(event)).toBe(false)
    expect(pipeline.check.groupCD).toEqual({})
    expect(pipeline.check.singleCD).toEqual({})

    await pipeline.commit.process(event)
    expect(pipeline.check.groupCD).toMatchObject({ 67890: true })
  })

  it("groupCD 生效后同群第二条被拦截", async () => {
    const pipeline = await setup()
    await run("group-command", { overrides: { only_reply_at: 1 } }, pipeline)
    expect(pipeline.commit.rateLimit.groupCD).toMatchObject({ 67890: true })
  })

  it("singleCD 生效后同一用户第二条被拦截", async () => {
    const pipeline = await setup()
    await run("group-command", { overrides: { only_reply_at: 1 } }, pipeline)
    const second = await run("group-command", { overrides: { only_reply_at: 1 } }, pipeline)
    expect(pipeline.ctx.isStopped(second)).toBe(true)
  })

  it("singleCD 的键是 umo 前缀（会话 + 用户）", async () => {
    // 阶段 4 v2 起键从 `${group_id}.${user_id}` 换成 `${umo}.${user_id}`。
    // 这里逐字断言，是为了让"改键"这件事必须显式过一遍测试。
    const pipeline = await setup({ groups: { 67890: { groupCD: 0, singleCD: 2000 } } })
    await run("group-command", { overrides: { only_reply_at: 1 } }, pipeline)
    expect(Object.keys(pipeline.check.singleCD)).toEqual(["QQ:12345:group:67890.10001"])
  })

  it("同一个人在不同群发同一句话不再被误去重（umo 键含群号）", async () => {
    // 阶段 4 v2 顺手修掉的行为：旧键是 `${self_id}:${user_id}:${raw_message}`，
    // 里面没有群号，于是"同一个人换一个群发同样的话"会被判成重复。
    const pipeline = await setup({ groups: { 67890: { groupCD: 0, singleCD: 0 } } })

    const first = await run("group-command", {}, pipeline)
    expect(pipeline.ctx.isStopped(first)).toBe(false)

    const otherGroup = await run("group-command", { overrides: { group_id: 11111 } }, pipeline)
    expect(pipeline.ctx.isStopped(otherGroup)).toBe(false)
  })

  it("同一个群里的同文仍然被去重（防止上面那条修过头）", async () => {
    const pipeline = await setup({ groups: { 67890: { groupCD: 0, singleCD: 0 } } })
    await run("group-command", {}, pipeline)
    const second = await run("group-command", {}, pipeline)
    expect(pipeline.ctx.isStopped(second)).toBe(true)
  })

  it("群冷却关闭时不写表", async () => {
    const pipeline = await setup({ groups: { 67890: { groupCD: 0, singleCD: 0 } } })
    await run("group-command", { overrides: { only_reply_at: 1 } }, pipeline)
    expect(pipeline.check.groupCD).toEqual({})
    expect(pipeline.check.singleCD).toEqual({})
  })

  it("超过 groupCD 秒数后放行", async () => {
    vi.useFakeTimers()
    const pipeline = await setup({ groups: { 67890: { groupCD: 1, singleCD: 0 } } })

    await run("group-command", { overrides: { only_reply_at: 1 } }, pipeline)
    expect(pipeline.check.groupCD).toMatchObject({ 67890: true })

    await vi.advanceTimersByTimeAsync(1100)
    expect(pipeline.check.groupCD).toEqual({})
  })
})

describe("RateLimitCommitStage：提交条件", () => {
  it("only_reply_at 为假时不提交", async () => {
    const pipeline = await setup()
    await run("group-command", {}, pipeline)
    expect(pipeline.check.groupCD).toEqual({})
    expect(pipeline.check.singleCD).toEqual({})
  })

  it("私聊不提交群/单人冷却", async () => {
    const pipeline = await setup()
    await run("private-command", { overrides: { only_reply_at: 1, isPrivate: true } }, pipeline)
    expect(pipeline.check.groupCD).toEqual({})
    expect(pipeline.check.singleCD).toEqual({})
  })

  it("冷却是按档案隔离的——两个档案各有一份表", async () => {
    const first = await setup()
    const second = await setup()
    await run("group-command", { overrides: { only_reply_at: 1 } }, first)

    expect(first.check.groupCD).toMatchObject({ 67890: true })
    expect(second.check.groupCD).toEqual({})
  })
})

describe("RateLimitCommitStage：时序契约", () => {
  it("缺少 RateLimitCheckStage 时初始化直接抛错", async () => {
    await expect(
      setupPipeline([RateLimitCommitStage], { cfg: createConfigStub() }),
    ).rejects.toThrow(/RateLimitCheckStage/)
  })
})
