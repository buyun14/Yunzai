import { afterEach, describe, expect, it, vi } from "vitest"
import { PreProcessStage } from "../../../../lib/pipeline/stages/pre-process.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { createLoaderStub, setupPipeline } from "../../../helpers/pipeline.js"

/**
 * 跑一次预处理阶段。
 *
 * @param {string} name 样本名
 * @param {Record<string, unknown>} [overrides] 事件字段覆盖项
 * @returns {Promise<{ event: object, sent: unknown[], loader: object, runtime: object }>} 结果
 */
async function pre(name, overrides = {}) {
  const loader = createLoaderStub()
  const runtime = { init: vi.fn(async () => {}) }
  const { stages } = await setupPipeline([PreProcessStage], {
    cfg: createConfigStub(),
    loader,
    runtime,
  })
  const { event, sent } = makeEvent(name, overrides)
  await stages[0].process(event)
  return { event, sent, loader, runtime }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("PreProcessStage：reply 包装", () => {
  it("空消息直接返回 false，不发送", async () => {
    const { event, sent, loader } = await pre("group-command")
    await expect(event.reply("")).resolves.toBe(false)
    expect(sent).toEqual([])
    expect(loader.counted).toEqual([])
  })

  it("普通文本原样发送", async () => {
    const { event, sent } = await pre("group-command")
    await event.reply("你好")
    expect(sent).toEqual([{ msg: "你好", quote: false, data: {} }])
  })

  it("at: true 时注入 at 段（群聊，指向发送者）", async () => {
    const { event, sent } = await pre("group-command", { isGroup: true })
    await event.reply("你好", false, { at: true })
    expect(sent[0].msg).toEqual([{ type: "at", qq: 10001 }, "\n", "你好"])
  })

  it("at 指定 id 时注入该 id", async () => {
    const { event, sent } = await pre("group-command", { isGroup: true })
    await event.reply("你好", false, { at: 10002 })
    expect(sent[0].msg[0]).toEqual({ type: "at", qq: 10002 })
  })

  it("isGroup 未置位时不注入 at（该字段由归一化阶段赋值）", async () => {
    const { event, sent } = await pre("group-command")
    await event.reply("你好", false, { at: true })
    expect(sent[0].msg).toBe("你好")
  })

  it("私聊不注入 at", async () => {
    const { event, sent } = await pre("private-command", { isGroup: false })
    await event.reply("你好", false, { at: true })
    expect(sent[0].msg).toBe("你好")
  })

  it("at 注入对消息数组同样生效（前插）", async () => {
    const { event, sent } = await pre("group-command", { isGroup: true })
    await event.reply(["原本的内容"], false, { at: 10002 })
    expect(sent[0].msg).toEqual([{ type: "at", qq: 10002 }, "\n", "原本的内容"])
  })

  it("quote 且有 message_id 时注入引用段", async () => {
    const { event, sent } = await pre("group-command")
    await event.reply("你好", true)
    expect(sent[0].msg).toEqual([{ type: "reply", id: 1000 }, "你好"])
  })

  it("quote 但无 message_id 时不注入", async () => {
    const { event, sent } = await pre("group-command", { message_id: undefined })
    await event.reply("你好", true)
    expect(sent[0].msg).toBe("你好")
  })

  it("at 与 quote 叠加时 quote 在前（先注入 at 成数组，再 unshift quote）", async () => {
    const { event, sent } = await pre("group-command", { isGroup: true })
    await event.reply("你好", true, { at: true })
    expect(sent[0].msg).toEqual([
      { type: "reply", id: 1000 },
      { type: "at", qq: 10001 },
      "\n",
      "你好",
    ])
  })
})

describe("PreProcessStage：异常兜底", () => {
  it("发送失败时不抛出，改为返回 { error: [...] }", async () => {
    const boom = new Error("网络抖动")
    const { event } = await pre("group-command", {
      reply: async () => {
        throw boom
      },
    })

    await expect(event.reply("你好")).resolves.toEqual({ error: [boom] })
  })

  it("发送失败会记 error 日志", async () => {
    const { event } = await pre("group-command", {
      reply: async () => {
        throw new Error("网络抖动")
      },
    })
    const before = globalThis.Bot.logs.length
    await event.reply("你好")

    const added = globalThis.Bot.logs.slice(before)
    expect(added).toHaveLength(1)
    expect(added[0][0]).toBe("error")
    expect(added[0][1]).toMatchObject({ 0: "发送消息错误", 1: "你好" })
  })
})

describe("PreProcessStage：定时撤回", () => {
  it("recallMsg > 0 且发送成功时定时撤回，同时撤回触发消息", async () => {
    vi.useFakeTimers()
    const { event } = await pre("group-command")
    const recall = vi.spyOn(event.group, "recallMsg")

    await event.reply("你好", false, { recallMsg: 1 })
    expect(recall).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(recall).toHaveBeenCalledWith("sent-1")
    expect(recall).toHaveBeenCalledWith(1000)
  })

  it("recallMsg 为 0 时不设撤回", async () => {
    vi.useFakeTimers()
    const { event } = await pre("group-command")
    const recall = vi.spyOn(event.group, "recallMsg")

    await event.reply("你好")
    await vi.advanceTimersByTimeAsync(5000)
    expect(recall).not.toHaveBeenCalled()
  })

  it("发送失败（无 message_id）时不设撤回", async () => {
    vi.useFakeTimers()
    const { event } = await pre("group-command", { reply: async () => ({}) })
    const recall = vi.spyOn(event.group, "recallMsg")

    await event.reply("你好", false, { recallMsg: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(recall).not.toHaveBeenCalled()
  })

  it("事件没有 message_id 时只撤回发出的那条", async () => {
    vi.useFakeTimers()
    const { event } = await pre("group-command", { message_id: undefined })
    const recall = vi.spyOn(event.group, "recallMsg")

    await event.reply("你好", false, { recallMsg: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(recall).toHaveBeenCalledExactlyOnceWith("sent-1")
  })

  it("私聊时走 friend 的召回", async () => {
    vi.useFakeTimers()
    // 样本里没有 friend 字段，这里显式补一个（真实环境由适配器提供）
    const recallMsg = vi.fn(async () => true)
    const { event } = await pre("private-command", { friend: { recallMsg } })

    await event.reply("你好", false, { recallMsg: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(recallMsg).toHaveBeenCalledWith("sent-1")
  })
})

describe("PreProcessStage：计数与 runtime", () => {
  it("发送后计入 send", async () => {
    const { event, loader } = await pre("group-command")
    await event.reply("你好")
    expect(loader.counted).toEqual([{ type: "send", msg: "你好" }])
  })

  it("at 注入后的数组作为计数内容", async () => {
    const { event, loader } = await pre("group-command", { isGroup: true })
    await event.reply("你好", false, { at: 10002 })
    expect(loader.counted[0].msg).toEqual([{ type: "at", qq: 10002 }, "\n", "你好"])
  })

  it("runtime.init 收到事件对象", async () => {
    const { event, runtime } = await pre("group-command")
    expect(runtime.init).toHaveBeenCalledExactlyOnceWith(event)
  })

  it("没有 runtime 时不报错", async () => {
    const { stages } = await setupPipeline([PreProcessStage], { cfg: createConfigStub() })
    const { event } = makeEvent("group-command")
    await expect(stages[0].process(event)).resolves.toBeUndefined()
  })

  it("事件没有 reply 方法时不包装，也不报错", async () => {
    const { stages } = await setupPipeline([PreProcessStage], { cfg: createConfigStub() })
    const { event } = makeEvent("group-command", { reply: undefined })
    await stages[0].process(event)
    expect(event.reply).toBeUndefined()
  })

  it("把裸 reply 换成包装后的函数", async () => {
    const { stages } = await setupPipeline([PreProcessStage], { cfg: createConfigStub() })
    const { event } = makeEvent("group-command")
    const bare = event.reply

    await stages[0].process(event)

    expect(event.reply).toBeTypeOf("function")
    expect(event.reply).not.toBe(bare)
  })

  it("不停止事件——后续阶段照常执行", async () => {
    const loader = createLoaderStub()
    const { ctx, stages } = await setupPipeline([PreProcessStage], {
      cfg: createConfigStub(),
      loader,
    })
    const { event } = makeEvent("group-command")
    await stages[0].process(event)
    expect(ctx.isStopped(event)).toBe(false)
  })
})
