import { describe, expect, it } from "vitest"
import { WhitelistCheckStage } from "../../../../lib/pipeline/stages/whitelist-check.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { setupPipeline } from "../../../helpers/pipeline.js"

/** 样本里的固定值（见 tests/fixtures/events/group-command.json） */
const SELF_ID = 12345
const USER_ID = 10001
const GROUP_ID = 67890

/**
 * 跑一次黑白名单检查。
 *
 * @param {string} name 样本名
 * @param {object} [other] `other` 配置覆盖项
 * @param {Record<string, unknown>} [overrides] 事件字段覆盖项
 * @returns {Promise<{ event: object, ctx: object }>} 结果
 */
async function check(name, other = {}, overrides = {}) {
  const { ctx, stages } = await setupPipeline([WhitelistCheckStage], {
    cfg: createConfigStub({ other }),
  })
  const { event } = makeEvent(name, overrides)
  await stages[0].process(event)
  return { event, ctx }
}

describe("WhitelistCheckStage：黑名单", () => {
  it("黑名单用户被拦截", async () => {
    const { event, ctx } = await check("group-command", { blackUser: [USER_ID] })
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("黑名单未命中时放行", async () => {
    const { event, ctx } = await check("group-command", { blackUser: [99999] })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("黑名单群被拦截", async () => {
    const { event, ctx } = await check("group-command", { blackGroup: [GROUP_ID] })
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("user_id 是字符串时仍能命中数字名单", async () => {
    const { event, ctx } = await check(
      "group-command",
      { blackUser: [USER_ID] },
      { user_id: String(USER_ID) },
    )
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("user_id 是数字时命中字符串名单——不命中（既有行为，勿改）", async () => {
    const { event, ctx } = await check("group-command", { blackUser: [String(USER_ID)] })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("名单为空数组等于不启用", async () => {
    const { event, ctx } = await check("group-command", { blackUser: [], blackGroup: [] })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("self_id 不影响名单判定（名单只看用户/群）", async () => {
    const { event, ctx } = await check("group-command", { blackUser: [SELF_ID] })
    expect(ctx.isStopped(event)).toBe(false)
  })
})

describe("WhitelistCheckStage：白名单", () => {
  it("白名单非空且不含该用户时拦截", async () => {
    const { event, ctx } = await check("group-command", { whiteUser: [10002] })
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("白名单非空且含该用户时放行", async () => {
    const { event, ctx } = await check("group-command", { whiteUser: [10002, USER_ID] })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("白名单为空数组等于不启用（放行）", async () => {
    const { event, ctx } = await check("group-command", { whiteUser: [] })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("白名单群非空且不含该群时拦截", async () => {
    const { event, ctx } = await check("group-command", { whiteGroup: [111111] })
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("白名单群含该群时放行", async () => {
    const { event, ctx } = await check("group-command", { whiteGroup: [GROUP_ID] })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("私聊不检查群名单——白名单群非空时私聊仍放行", async () => {
    const { event, ctx } = await check("private-command", { whiteGroup: [111111] })
    expect(event.group_id).toBeUndefined()
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("私聊仍检查用户名单", async () => {
    const { event, ctx } = await check("private-command", { whiteUser: [10002] })
    expect(ctx.isStopped(event)).toBe(true)
  })
})

describe("WhitelistCheckStage：优先级", () => {
  it("用户黑名单先于用户白名单判定", async () => {
    const { event, ctx } = await check("group-command", {
      blackUser: [USER_ID],
      whiteUser: [USER_ID],
    })
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("用户名单先于群名单判定", async () => {
    const { event, ctx } = await check("group-command", {
      blackUser: [USER_ID],
      whiteGroup: [111111],
    })
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("全部名单为空时放行", async () => {
    const { event, ctx } = await check("group-command")
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("notice 事件也会被名单拦截", async () => {
    const { event, ctx } = await check("notice-group-increase", { blackGroup: [GROUP_ID] })
    expect(ctx.isStopped(event)).toBe(true)
  })
})
