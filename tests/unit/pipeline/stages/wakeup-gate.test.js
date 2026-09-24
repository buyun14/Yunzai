import { describe, expect, it, vi } from "vitest"
import { WakeupGateStage } from "../../../../lib/pipeline/stages/wakeup-gate.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"
import { createLoaderStub, makePluginEntry, setupPipeline } from "../../../helpers/pipeline.js"

/**
 * 跑一次唤醒门槛阶段。
 *
 * @param {string} name 样本名
 * @param {Array<object>} entries `priority` 列表
 * @param {{ other?: object, overrides?: object }} [opts] 选项
 * @returns {Promise<{ event: object, ctx: object }>} 结果
 */
async function gate(name, entries, opts = {}) {
  const loader = createLoaderStub(entries)
  const { ctx, stages } = await setupPipeline([WakeupGateStage], {
    cfg: createConfigStub({ other: opts.other, groups: opts.groups }),
    loader,
  })
  const { event } = makeEvent(name, opts.overrides)
  // ProfileResolveStage 会把群配置写进状态；这里手动补上（`deal()` 第 3 步等价）
  ctx.stateOf(event).groupCfg = ctx.cfg.getGroup(event.self_id, event.group_id)
  await stages[0].process(event)
  return { event, ctx }
}

describe("WakeupGateStage：插件筛选", () => {
  it("默认配置下 disable 命中的插件被排除", async () => {
    const enabled = makePluginEntry("随便一个插件")
    const disabled = makePluginEntry("禁用示例")
    const { event, ctx } = await gate("group-command", [enabled, disabled])

    expect(ctx.stateOf(event).priority).toEqual([enabled])
  })

  it("群配置里的 enable 是白名单：非空且不含该插件时同样被排除", async () => {
    const kept = makePluginEntry("白名单里的插件")
    const dropped = makePluginEntry("没在名单里")
    const { event, ctx } = await gate("group-command", [kept, dropped], {
      groups: { 67890: { enable: ["白名单里的插件"] } },
    })

    expect(ctx.stateOf(event).priority).toEqual([kept])
  })

  it("disable 优先于 enable", async () => {
    const entry = makePluginEntry("两处都有")
    const { event, ctx } = await gate("group-command", [entry], {
      groups: { 67890: { enable: ["两处都有"], disable: ["两处都有"] } },
    })

    expect(ctx.stateOf(event).priority).toEqual([])
  })

  it("event 声明不匹配的插件被排除", async () => {
    const groupOnly = makePluginEntry("仅群聊", { event: "message.group.normal" })
    const privateOnly = makePluginEntry("仅私聊", { event: "message.private.friend" })
    const { event, ctx } = await gate("group-command", [groupOnly, privateOnly])

    expect(ctx.stateOf(event).priority).toEqual([groupOnly])
  })

  it("通配符能匹配任意一段", async () => {
    const anyGroup = makePluginEntry("任意群聊", { event: "message.group.*" })
    const { event, ctx } = await gate("group-command", [anyGroup])
    expect(ctx.stateOf(event).priority).toEqual([anyGroup])
  })

  it("没有 event 声明的插件被排除（filtEvent 的第一条规则）", async () => {
    const entry = makePluginEntry("没声明")
    delete entry.plugin.event
    const { event, ctx } = await gate("group-command", [entry])
    expect(ctx.stateOf(event).priority).toEqual([])
  })

  it("筛选保留原列表顺序", async () => {
    const a = makePluginEntry("A")
    const b = makePluginEntry("B")
    const c = makePluginEntry("C")
    const { event, ctx } = await gate("group-command", [c, a, b])
    expect(ctx.stateOf(event).priority).toEqual([c, a, b])
  })

  it("priority 写入事件状态供 ProcessStage 复用", async () => {
    const entry = makePluginEntry("插件A")
    const { event, ctx } = await gate("group-command", [entry])
    expect(ctx.stateOf(event).priority).toBeInstanceOf(Array)
    expect(ctx.stateOf(event).priority[0]).toBe(entry)
  })

  it("筛选阶段把 e 挂到**共享**的插件实例上（插件契约的一部分）", async () => {
    const entry = makePluginEntry("插件A")
    const { event } = await gate("group-command", [entry])
    expect(entry.plugin.e).toBe(event)
  })

  it("插件被筛掉时 e 同样被挂上（旧实现是参数求值，先于判断）", async () => {
    const entry = makePluginEntry("被禁用的插件")
    const { event } = await gate("group-command", [entry], {
      groups: { 67890: { disable: ["被禁用的插件"] } },
    })
    expect(event).toBeDefined()
    expect(entry.plugin.e).toBe(event)
  })
})

describe("WakeupGateStage：context hook", () => {
  it("getContext 返回空对象时跳过该插件", async () => {
    const hook = vi.fn(async () => ({}))
    const entry = makePluginEntry("空上下文", { getContext: () => ({}) }, { hook })
    const { event, ctx } = await gate("group-command", [entry])

    expect(hook).not.toHaveBeenCalled()
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("没有 getContext 的插件被跳过", async () => {
    const entry = makePluginEntry("无钩子")
    const { event, ctx } = await gate("group-command", [entry])
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("getContext 会被调用两次（全集 + 当前上下文）", async () => {
    const getContext = vi.fn(() => ({}))
    const entry = makePluginEntry("两次", { getContext }, {})
    await gate("group-command", [entry])

    expect(getContext).toHaveBeenCalledTimes(2)
    expect(getContext).toHaveBeenNthCalledWith(1)
    expect(getContext).toHaveBeenNthCalledWith(2, false, true)
  })

  it("钩子返回 continue 时放行给下一个插件", async () => {
    const first = vi.fn(async () => "continue")
    const second = vi.fn(async () => "handled")
    const entries = [
      makePluginEntry("先", { getContext: () => ({ onMsg: "any" }) }, { onMsg: first }),
      makePluginEntry("后", { getContext: () => ({ onMsg: "any" }) }, { onMsg: second }),
    ]
    const { event, ctx } = await gate("group-command", entries)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("钩子返回非 continue 时立即停止，后续插件不再执行", async () => {
    const first = vi.fn(async () => "handled")
    const second = vi.fn(async () => "continue")
    const entries = [
      makePluginEntry("先", { getContext: () => ({ onMsg: "any" }) }, { onMsg: first }),
      makePluginEntry("后", { getContext: () => ({ onMsg: "any" }) }, { onMsg: second }),
    ]
    const { event, ctx } = await gate("group-command", entries)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("钩子收到 getContext 的返回值作为参数", async () => {
    const hook = vi.fn(async () => "continue")
    const entry = makePluginEntry(
      "传参",
      { getContext: () => ({ onMsg: "载荷" }) },
      { onMsg: hook },
    )
    await gate("group-command", [entry])

    expect(hook).toHaveBeenCalledWith("载荷")
  })

  it("getContext 以插件实例为 this 调用（真实实现在里面读 this.e）", async () => {
    const hook = vi.fn(async () => "continue")
    const entry = makePluginEntry(
      "读this",
      {
        // 照真实 plugin.js 的形态写：getContext 内部经由 this 取会话键。
        // 若被拆成裸函数调用，这里会直接抛 TypeError。
        getContext() {
          return { onMsg: `${this.name}:${this.e.user_id}` }
        },
      },
      { onMsg: hook },
    )
    await gate("group-command", [entry])

    expect(hook).toHaveBeenCalledWith("读this:10001")
  })

  it("getContext 依赖 this.e 时不会因为 e 没挂上而抛错", async () => {
    const entry = makePluginEntry(
      "用conKey",
      {
        getContext(isGroup) {
          // 与 plugin.js 的 conKey 同形
          const key = `${this.name}.${this.e.self_id}.${isGroup ? this.e.group_id : this.e.user_id}`
          return isGroup ? { onMsg: key } : {}
        },
      },
      { onMsg: async () => "continue" },
    )
    const { event, ctx } = await gate("group-command", [entry])

    expect(ctx.isStopped(event)).toBe(true)
  })

  it("插件实例能拿到事件对象（e 与构造参数都注入）", async () => {
    let seen
    class Probe {
      constructor(event) {
        seen = { ctor: event }
      }
      async onMsg() {
        seen.self = this.e
        return "continue"
      }
    }
    const entry = {
      plugin: { name: "探针", event: "message.*.*", getContext: () => ({ onMsg: "x" }) },
      class: Probe,
    }
    const { event } = await gate("group-command", [entry])

    expect(seen.ctor).toBe(event)
    expect(seen.self).toBe(event)
  })

  it("钩子抛出的异常向上传播（旧实现不吞异常）", async () => {
    const entry = makePluginEntry(
      "炸",
      { getContext: () => ({ onMsg: "any" }) },
      {
        onMsg: async () => {
          throw new Error("boom")
        },
      },
    )
    await expect(gate("group-command", [entry])).rejects.toThrow("boom")
  })
})

describe("WakeupGateStage：唤醒门槛", () => {
  it("only_reply_at 为假时停止", async () => {
    const { event, ctx } = await gate("group-command", [])
    expect(ctx.isStopped(event)).toBe(true)
  })

  it("only_reply_at 为真时放行", async () => {
    const { event, ctx } = await gate("group-command", [], {
      overrides: { only_reply_at: true },
    })
    expect(ctx.isStopped(event)).toBe(false)
  })

  it("唤醒门槛排在 context hook 之后——未唤醒时钩子仍然执行", async () => {
    const hook = vi.fn(async () => "continue")
    const entry = makePluginEntry("钩子", { getContext: () => ({ onMsg: "any" }) }, { onMsg: hook })
    const { event, ctx } = await gate("group-command", [entry], {
      overrides: { only_reply_at: false },
    })

    expect(hook).toHaveBeenCalledTimes(1)
    expect(ctx.isStopped(event)).toBe(true)
  })
})
