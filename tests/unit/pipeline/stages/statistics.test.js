import { describe, expect, it } from "vitest"
import { StatisticsStage } from "../../../../lib/pipeline/stages/statistics.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { createLoaderStub, setupPipeline } from "../../../helpers/pipeline.js"

/**
 * 跑一次统计阶段。
 *
 * @param {string} name 样本名
 * @returns {Promise<{ event: object, loader: ReturnType<typeof createLoaderStub> }>} 结果
 */
async function stat(name) {
  const loader = createLoaderStub()
  const { stages } = await setupPipeline([StatisticsStage], {
    cfg: createConfigStub(),
    loader,
  })
  const { event } = makeEvent(name)
  await stages[0].process(event)
  return { event, loader }
}

describe("StatisticsStage", () => {
  it("把消息计为 receive，透传原始 message 数组", async () => {
    const { event, loader } = await stat("group-command")
    expect(loader.counted).toEqual([{ type: "receive", msg: event.message }])
  })

  it("计的是 message 而不是归一化后的 msg", async () => {
    const { event, loader } = await stat("group-command")
    // 归一化尚未运行，msg 还不存在
    expect(event.msg).toBeUndefined()
    expect(loader.counted[0].msg).toBe(event.message)
  })

  it("不改动事件对象上的任何字段", async () => {
    const { event } = await stat("group-command")
    expect(event.only_reply_at).toBeUndefined()
    expect(event.isGroup).toBeUndefined()
  })

  it("不停止事件——后续阶段照常执行", async () => {
    const loader = createLoaderStub()
    const { ctx, stages } = await setupPipeline([StatisticsStage], {
      cfg: createConfigStub(),
      loader,
    })
    const { event } = makeEvent("group-command")
    await stages[0].process(event)
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("notice 事件同样计入", async () => {
    const { loader } = await stat("notice-group-increase")
    expect(loader.counted).toHaveLength(1)
    expect(loader.counted[0].type).toBe("receive")
  })
})
