import { describe, expect, it, vi } from "vitest"
import { EventBus } from "../../lib/event-bus.js"
import { PipelineScheduler } from "../../lib/pipeline/scheduler.js"
import { createConfigStub } from "../helpers/config.js"
import { makeEvent } from "../helpers/events.js"
import { createLoaderStub } from "../helpers/pipeline.js"

// event-bus.js 经 loader.js 间接拉入 runtime.js（puppeteer），与断言无关
vi.mock("../../lib/plugins/runtime.js", () => ({ default: { init: async () => {} } }))

/**
 * 造一个总线。
 *
 * `loader` 必须是**完整**的替身：流水线在运行时要读 `priority` 与 `count`，
 * 缺一个第一条消息就报错。
 *
 * @param {object} [opts] 选项
 * @param {object} [opts.cfg] 配置替身覆盖项
 * @returns {{ bus: EventBus, loader: object }} 总线与加载器替身
 */
function makeBus(opts = {}) {
  const loader = createLoaderStub()
  const bus = new EventBus({
    loader,
    cfg: createConfigStub(opts.cfg),
    runtime: { init: async () => {} },
  })
  return { bus, loader }
}

/**
 * @param {number} selfId bot 账号
 * @returns {Record<string, unknown>} 事件对象
 */
function eventFor(selfId) {
  const { event } = makeEvent("group-command", { self_id: selfId })
  return event
}

describe("EventBus：装配档案时留下日志", () => {
  it("每个档案装配一次流水线并打一条日志", async () => {
    const { bus } = makeBus()
    /**
     * 只取与装配有关的日志——阶段自己还会打 `暂无插件处理` 之类的 debug 行。
     *
     * @param {number} from 起始下标
     * @returns {unknown[][]} 匹配的日志
     */
    const assemblyLogs = from =>
      globalThis.Bot.logs
        .slice(from)
        .filter(args => JSON.stringify(args).includes("已装配消息流水线"))

    const before = globalThis.Bot.logs.length

    await bus.commit(eventFor(12345))
    expect(assemblyLogs(before)).toHaveLength(1)
    expect(JSON.stringify(assemblyLogs(before)[0])).toContain("12345")

    // 同一个档案不重复打（它与阶段实例一一对应）
    await bus.commit(eventFor(12345))
    expect(assemblyLogs(before)).toHaveLength(1)

    // 新档案各打一条，便于排查“某个账号的消息没反应”
    await bus.commit(eventFor(54321))
    expect(assemblyLogs(before)).toHaveLength(2)
  })

  it("旧路径开关已删除，配置里残留的 bot.legacy_pipeline 不影响路由", async () => {
    const { bus } = makeBus({ cfg: { bot: { legacy_pipeline: true } } })
    await bus.commit(eventFor(12345))
    expect(bus.profiles.get("12345").scheduler).toBeInstanceOf(PipelineScheduler)
  })
})

describe("EventBus：档案隔离", () => {
  it("不同 self_id 得到不同的调度器与阶段实例", async () => {
    const { bus } = makeBus()
    await bus.commit(eventFor(12345))
    await bus.commit(eventFor(54321))

    const first = bus.profiles.get("12345").scheduler
    const second = bus.profiles.get("54321").scheduler

    expect(first).not.toBe(second)
    expect(first.ctx).not.toBe(second.ctx)
    expect(first.ctx.stages[0]).not.toBe(second.ctx.stages[0])
  })

  it("同一个 self_id 复用同一套阶段实例（状态依赖实例不被重建）", async () => {
    const { bus } = makeBus()
    await bus.commit(eventFor(12345))
    const first = bus.profiles.get("12345").scheduler

    await bus.commit(eventFor(12345))
    expect(bus.profiles.get("12345").scheduler).toBe(first)
    expect(bus.profiles.size).toBe(1)
  })

  it("档案标识就是 self_id", () => {
    const { bus } = makeBus()
    expect(bus.profileKey({ self_id: 12345 })).toBe("12345")
    expect(bus.profileKey({ self_id: "stdin" })).toBe("stdin")
    expect(bus.profileKey({})).toBe("")
  })

  it("两个账号的限流表互不影响（问题 C 的回归用例）", async () => {
    const { bus } = makeBus()
    await bus.commit(eventFor(12345))
    await bus.commit(eventFor(54321))

    /**
     * @param {string} key 档案标识
     * @returns {Record<string, unknown>} 该档案的限流检查阶段
     */
    const limitOf = key =>
      bus.profiles.get(key).scheduler.ctx.stages.find(stage => "msgThrottle" in stage)

    const a = limitOf("12345")
    const b = limitOf("54321")
    expect(a).not.toBe(b)
    expect(a.msgThrottle).not.toBe(b.msgThrottle)

    // 两边都因为各自的事件写过自己的表（键含 self_id，所以内容本就不同）；
    // 关键是**互不串**：往 A 写不会出现在 B 里
    const probe = "probe-key"
    a.msgThrottle[probe] = true
    expect(b.msgThrottle).not.toHaveProperty(probe)
    expect(a.msgThrottle[probe]).toBe(true)
  })
})

describe("EventBus：初始化", () => {
  it("每个档案只初始化一次调度器", async () => {
    const spy = vi.spyOn(PipelineScheduler.prototype, "initialize")
    const { bus } = makeBus()

    try {
      await bus.commit(eventFor(12345))
      await bus.commit(eventFor(12345))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("并发的首条消息共享同一次初始化", async () => {
    const spy = vi.spyOn(PipelineScheduler.prototype, "initialize")
    const { bus } = makeBus()

    try {
      await Promise.all([bus.commit(eventFor(12345)), bus.commit(eventFor(12345))])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(bus.profiles.size).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("初始化失败时把档案摘掉，下一条消息会重试", async () => {
    const spy = vi
      .spyOn(PipelineScheduler.prototype, "initialize")
      .mockRejectedValueOnce(new Error("阶段装配失败"))

    const { bus } = makeBus()
    try {
      await expect(bus.commit(eventFor(12345))).rejects.toThrow("阶段装配失败")
      expect(bus.profiles.has("12345")).toBe(false)

      // 重试成功——失败没有被永久缓存
      await expect(bus.commit(eventFor(12345))).resolves.toBeUndefined()
      expect(bus.profiles.get("12345").scheduler).toBeInstanceOf(PipelineScheduler)
    } finally {
      spy.mockRestore()
    }
  })

  it("prewarm 提前建好档案", async () => {
    const { bus } = makeBus()
    await bus.prewarm(12345)
    expect(bus.profiles.get("12345").scheduler).toBeInstanceOf(PipelineScheduler)
  })

  it("shutdown 清空全部档案", async () => {
    const { bus } = makeBus()
    await bus.commit(eventFor(12345))
    bus.shutdown()
    expect(bus.profiles.size).toBe(0)
  })
})

describe("EventBus：调用契约", () => {
  it("新路径不改写 self_id，档案路由与 cfg.getGroup 的键空间一致", async () => {
    const { bus } = makeBus()
    const event = eventFor(12345)
    await bus.commit(event)
    expect(event.self_id).toBe(12345)
  })

  it("commit 返回 Promise，不保证已处理完（调用方决定是否 await）", async () => {
    const { bus } = makeBus()
    const result = bus.commit(eventFor(12345))
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  it("私聊事件同样按 self_id 归档", async () => {
    const { bus } = makeBus()
    const { event } = makeEvent("private-command")
    await bus.commit(event)
    expect(bus.profiles.has(String(event.self_id))).toBe(true)
  })
})
