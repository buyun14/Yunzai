import { describe, expect, it, vi } from "vitest"
import { NormalizeStage } from "../../../../lib/pipeline/stages/normalize.js"
import { ProcessStage } from "../../../../lib/pipeline/stages/process.js"
import { WakeupGateStage } from "../../../../lib/pipeline/stages/wakeup-gate.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { createLoaderStub, makePluginEntry, setupPipeline } from "../../../helpers/pipeline.js"

/**
 * 装配「归一化 + 唤醒门槛 + 处理」三个阶段。
 *
 * 必须带上 `NormalizeStage`：`ProcessStage` 读的 `event.msg` 是归一化产出的，
 * 跳过它的话 `rule.reg.test(undefined)` 永远不匹配，测试会变成假阳性。
 * `only_reply_at` 也由归一化算出，因此**不要**在 overrides 里手工塞它。
 *
 * 三段顺序与 `STAGES_ORDER` 一致（5 → 8 → 9）。
 *
 * @param {Array<object>} entries `priority` 列表
 * @param {{ groups?: object, other?: object, overrides?: object }} [opts] 选项
 * @returns {Promise<{ event: object, sent: unknown[], ctx: object }>} 结果
 */
async function dispatch(entries, opts = {}) {
  const loader = createLoaderStub(entries)
  const { ctx, stages } = await setupPipeline([NormalizeStage, WakeupGateStage, ProcessStage], {
    cfg: createConfigStub({ groups: opts.groups, other: opts.other }),
    loader,
  })

  const { event, sent } = makeEvent("group-command", opts.overrides)
  // ProfileResolveStage 会把群配置写进状态；这里手动补上（`deal()` 第 3 步等价）
  ctx.stateOf(event).groupCfg = ctx.cfg.getGroup(event.self_id, event.group_id)

  for (const stage of stages) {
    if (ctx.isStopped(event)) break
    await stage.process(event)
  }
  return { event, sent, ctx }
}

describe("ProcessStage：accept", () => {
  it("accept 返回 return 时立即终止，不进入 rule", async () => {
    const handler = vi.fn()
    const entry = makePluginEntry(
      "靠 accept",
      { accept: async () => "return", rule: [{ reg: /复读/, fnc: "onMsg" }] },
      { onMsg: handler },
    )
    const { ctx, event } = await dispatch([entry])
    expect(ctx.isStopped(event)).toBe(true)
    expect(handler).not.toHaveBeenCalled()
  })

  it("accept 返回真值时跳出 accept 循环，继续走 rule", async () => {
    const first = vi.fn(async () => false)
    const second = vi.fn(async () => true)
    const entries = [
      makePluginEntry("先", { accept: first }),
      makePluginEntry(
        "后",
        { accept: second, rule: [{ reg: /复读/, fnc: "onMsg" }] },
        {
          onMsg: async () => true,
        },
      ),
    ]
    const { ctx, event } = await dispatch(entries)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("accept 全部返回假值时不影响后续 rule 匹配", async () => {
    const handler = vi.fn(async () => true)
    const entry = makePluginEntry(
      "假值",
      { accept: async () => false, rule: [{ reg: /复读/, fnc: "onMsg" }] },
      { onMsg: handler },
    )
    await dispatch([entry])
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe("ProcessStage：rule 匹配", () => {
  it("正则命中时调用处理器并终止", async () => {
    const handler = vi.fn(async () => true)
    const entry = makePluginEntry(
      "复读机",
      { rule: [{ reg: /复读/, fnc: "onMsg" }] },
      { onMsg: handler },
    )
    const { event, ctx } = await dispatch([entry])

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toBe(event)
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("正则不命中时不调用处理器", async () => {
    const handler = vi.fn()
    const entry = makePluginEntry(
      "不匹配",
      { rule: [{ reg: /^#天气/, fnc: "onMsg" }] },
      { onMsg: handler },
    )
    const { event, ctx } = await dispatch([entry])

    expect(handler).not.toHaveBeenCalled()
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("处理器返回 false 时继续尝试同一插件的后续规则", async () => {
    const first = vi.fn(async () => false)
    const second = vi.fn(async () => true)
    const entry = makePluginEntry(
      "多规则",
      {
        rule: [
          { reg: /复读/, fnc: "first" },
          { reg: /复读/, fnc: "second" },
        ],
      },
      { first, second },
    )
    await dispatch([entry])

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("处理器返回 false 但已无后续规则时仍然终止", async () => {
    const handler = vi.fn(async () => false)
    const entry = makePluginEntry(
      "最后一条",
      { rule: [{ reg: /复读/, fnc: "onMsg" }] },
      { onMsg: handler },
    )
    const { event, ctx } = await dispatch([entry])

    expect(handler).toHaveBeenCalledTimes(1)
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("rule 上的 event 声明不匹配时跳过该规则", async () => {
    const handler = vi.fn()
    const entry = makePluginEntry(
      "仅私聊规则",
      { rule: [{ event: "message.private.friend", reg: /复读/, fnc: "onMsg" }] },
      { onMsg: handler },
    )
    const { event, ctx } = await dispatch([entry])

    expect(handler).not.toHaveBeenCalled()
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("前一个插件的规则不匹配时继续尝试下一个插件", async () => {
    const first = vi.fn()
    const second = vi.fn(async () => true)
    const entries = [
      makePluginEntry("先", { rule: [{ reg: /^#天气/, fnc: "onMsg" }] }, { onMsg: first }),
      makePluginEntry("后", { rule: [{ reg: /复读/, fnc: "onMsg" }] }, { onMsg: second }),
    ]
    await dispatch(entries)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("没有插件处理时也终止事件", async () => {
    const { event, ctx } = await dispatch([])
    expect(ctx.isStopped(event)).toBe(true)
  })
})

describe("ProcessStage：权限", () => {
  const rule = { reg: /复读/, fnc: "onMsg", permission: "master" }

  it("非主人触发 master 规则时发送提示且不调用处理器", async () => {
    const handler = vi.fn()
    const entry = makePluginEntry("仅主人", { rule: [rule] }, { onMsg: handler })
    const { sent, ctx, event } = await dispatch([entry])

    expect(handler).not.toHaveBeenCalled()
    expect(sent).toEqual([{ msg: "暂无权限，只有主人才能操作", quote: false, data: {} }])
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("事件被标记为主人时放行", async () => {
    const handler = vi.fn(async () => true)
    const entry = makePluginEntry("仅主人", { rule: [rule] }, { onMsg: handler })
    await dispatch([entry], { overrides: { isMaster: true } })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("群管理规则对普通成员拦截", async () => {
    const handler = vi.fn()
    const entry = makePluginEntry(
      "仅管理",
      { rule: [{ reg: /复读/, fnc: "onMsg", permission: "admin" }] },
      { onMsg: handler },
    )
    const { sent } = await dispatch([entry])

    expect(handler).not.toHaveBeenCalled()
    expect(sent[0].msg).toBe("暂无权限，只有管理员才能操作")
  })

  it("群管理规则对管理员放行", async () => {
    const handler = vi.fn(async () => true)
    const entry = makePluginEntry(
      "仅管理",
      { rule: [{ reg: /复读/, fnc: "onMsg", permission: "admin" }] },
      { onMsg: handler },
    )
    await dispatch([entry], { overrides: { member: { is_admin: true } } })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("群主规则对管理员仍然拦截", async () => {
    const handler = vi.fn()
    const entry = makePluginEntry(
      "仅群主",
      { rule: [{ reg: /复读/, fnc: "onMsg", permission: "owner" }] },
      { onMsg: handler },
    )
    const { sent } = await dispatch([entry], { overrides: { member: { is_admin: true } } })

    expect(handler).not.toHaveBeenCalled()
    expect(sent[0].msg).toBe("暂无权限，只有群主才能操作")
  })
})

describe("ProcessStage：异常与日志", () => {
  it("处理器抛出异常时不向流水线上抛，改为记 error 日志", async () => {
    const entry = makePluginEntry(
      "会炸",
      { rule: [{ reg: /复读/, fnc: "onMsg" }] },
      {
        onMsg: async () => {
          throw new Error("boom")
        },
      },
    )
    const { event, ctx } = await dispatch([entry])

    expect(ctx.isStopped(event)).toBe(true)
    expect(globalThis.Bot.logs.some(args => args[0] === "error")).toBe(true)
  })

  it("正则命中但没有对应方法时按已处理处理（不抛错）", async () => {
    const entry = makePluginEntry("方法缺失", { rule: [{ reg: /复读/, fnc: "onMsg" }] })
    const { event, ctx } = await dispatch([entry])
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("命中时记录 logFnc，日志级别用 info", async () => {
    const entry = makePluginEntry(
      "日志",
      { rule: [{ reg: /复读/, fnc: "onMsg" }] },
      { onMsg: async () => true },
    )
    const before = globalThis.Bot.logs.length
    const { event } = await dispatch([entry])

    expect(event.logFnc).toBe("[日志(onMsg)]")
    expect(globalThis.Bot.logs.slice(before).some(args => args[0] === "info")).toBe(true)
  })

  it("rule.log === false 时降级为 debug 日志", async () => {
    const entry = makePluginEntry(
      "静默",
      { rule: [{ reg: /复读/, fnc: "onMsg", log: false }] },
      { onMsg: async () => true },
    )
    const before = globalThis.Bot.logs.length
    await dispatch([entry])

    const added = globalThis.Bot.logs.slice(before)
    expect(added.some(args => args[0] === "info")).toBe(false)
    expect(added.some(args => args[0] === "debug")).toBe(true)
  })

  it("没有插件处理时记 debug 日志", async () => {
    await dispatch([])
    expect(
      globalThis.Bot.logs.some(
        args => args[0] === "debug" && String(args[1]).includes("暂无插件处理"),
      ),
    ).toBe(true)
  })
})

describe("ProcessStage：游戏前缀归一化", () => {
  /**
   * 把消息换成指定文本跑一遍（只给 `message`，让归一化阶段自己拼 `msg`）。
   *
   * @param {string} text 原始消息
   * @returns {Promise<object>} 事件对象
   */
  async function withText(text) {
    const { event } = await dispatch([], {
      overrides: { raw_message: text, message: [{ type: "text", text }] },
    })
    return event
  }

  it("星铁前缀被归一化为 #星铁，并置 game 为 sr", async () => {
    const event = await withText("#*抽卡")
    expect(event.msg).toBe("#星铁抽卡")
    expect(event.game).toBe("sr")
  })

  it("绝区零前缀被归一化为 #绝区零，并置 game 为 zzz", async () => {
    const event = await withText("#%抽卡")
    expect(event.msg).toBe("#绝区零抽卡")
    expect(event.game).toBe("zzz")
  })

  it("isSr / isGs 是访问器，与 game 联动", async () => {
    const event = await withText("随便")
    event.isSr = true
    expect(event.game).toBe("sr")
    expect(event.isSr).toBe(true)
    expect(event.isGs).toBe(false)

    event.isGs = true
    expect(event.game).toBe("gs")
    expect(event.isSr).toBe(false)
  })

  it("普通消息不写入 game", async () => {
    const event = await withText("#复读")
    expect(event.game).toBeUndefined()
    expect(event.isSr).toBe(false)
    expect(event.isGs).toBe(false)
  })

  it("同一事件重复执行本阶段会抛错（defineProperty 不可重入）", async () => {
    const { ctx, stages } = await setupPipeline([ProcessStage], { cfg: createConfigStub() })
    const { event } = makeEvent("group-command", { msg: "#复读" })
    ctx.stateOf(event).priority = []

    await stages[0].process(event)
    // 影子运行必须用事件副本，否则这里就是真实后果
    await expect(stages[0].process(event)).rejects.toThrow(TypeError)
  })
})
