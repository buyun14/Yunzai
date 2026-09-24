import { describe, expect, it } from "vitest"
import { ProfileResolveStage } from "../../../../lib/pipeline/stages/profile-resolve.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { setupPipeline } from "../../../helpers/pipeline.js"

/** 样本里的固定值（见 tests/fixtures/events/group-command.json） */
const SELF_ID = 12345
const GROUP_ID = 67890

/**
 * 跑一次群配置解析。
 *
 * @param {string} name 样本名
 * @param {object} [cfgOverrides] 配置覆盖项
 * @returns {Promise<{ event: object, ctx: object, cfg: object }>} 结果
 */
async function resolve(name, cfgOverrides = {}) {
  const cfg = createConfigStub(cfgOverrides)
  const { ctx, stages } = await setupPipeline([ProfileResolveStage], { cfg })
  const { event } = makeEvent(name)
  await stages[0].process(event)
  return { event, ctx, cfg }
}

describe("ProfileResolveStage", () => {
  it("把解析结果写进事件状态", async () => {
    const { event, ctx, cfg } = await resolve("group-command")
    expect(ctx.stateOf(event).groupCfg).toEqual(cfg.getGroup(SELF_ID, GROUP_ID))
  })

  it("按 (self_id, group_id) 两个参数查配置", async () => {
    const { cfg } = await resolve("group-command")
    expect(cfg.calls.getGroup).toEqual([[SELF_ID, GROUP_ID]])
  })

  it("群专属配置能覆盖默认值", async () => {
    const { event, ctx } = await resolve("group-command", {
      groups: { [GROUP_ID]: { groupCD: 0 } },
    })
    expect(ctx.stateOf(event).groupCfg.groupCD).toBe(0)
  })

  it("私聊同样调用 getGroup（group_id 为 undefined），与旧实现一致", async () => {
    const { event, ctx, cfg } = await resolve("private-command")
    expect(event.group_id).toBeUndefined()
    expect(cfg.calls.getGroup).toEqual([[SELF_ID, undefined]])
    expect(ctx.stateOf(event).groupCfg).toBeDefined()
  })

  it("每次 process 只查一次配置", async () => {
    const { cfg } = await resolve("group-command")
    expect(cfg.calls.getGroup).toEqual([[SELF_ID, GROUP_ID]])
  })

  it("结果按事件隔离——两条事件各自写入自己的状态", async () => {
    const cfg = createConfigStub()
    const { ctx, stages } = await setupPipeline([ProfileResolveStage], { cfg })
    const first = makeEvent("group-command")
    const second = makeEvent("private-command")

    await stages[0].process(first.event)
    await stages[0].process(second.event)

    expect(ctx.stateOf(first.event).groupCfg).not.toBe(ctx.stateOf(second.event).groupCfg)
  })

  it("不停止事件——后续阶段照常执行", async () => {
    const { event, ctx } = await resolve("group-command")
    expect(ctx.isStopped(event)).toBe(false)
  })
})
