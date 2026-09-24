import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `Bot.debounce` 的表征测试（characterization test）。
 *
 * 为什么在阶段 3 补：基线文档把 `lib/util.js` 的 `no-unsafe-finally` 登记为缺陷 D1，
 * 并要求"修改必须配单测、且要覆盖被防抖函数 reject 的场景"。没有这个文件，
 * "改写是行为等价的"就只是一句声明。
 *
 * 这个文件同时把两处**容易被误读**的既有行为钉死：
 *
 * 1. **首个调用方拿得到 rejection。** D1 当时写的影响面是"异常将静默消失"，
 *    实测并非如此：`finally` 里的 return 只吞掉**排队那一次**看到的异常，
 *    首次调用方直接 await `promise.promise`，异常照常抛给他。
 *
 * 2. **延时取自调用时的 `this`，不是 `debounce` 的第二个参数。**
 *    `setTimeout(..., this?.[debounceTime] ?? 0)` 里的 `this` 是 `ret` 被调用时的
 *    this。真实用法（`lib/plugins/config.js` 的 `configSave()`）是裸调用，
 *    此时 `this` 是 undefined，于是首个调用的实际延时是 **0**，而不是默认的 5000；
 *    只有排队重试那一次才会带上闭包里的 5000（`ret.apply(Object.assign(...))`）。
 *    这里不做"修正"，只把现状固定下来——改时序属于语义变更，要单独评估。
 */

vi.stubGlobal("logger", {
  mark: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
})

const { default: util } = await import("../../../lib/util.js")

describe("util.debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("同一时窗内的多次调用只执行一次，且各调用方拿到同一个结果", async () => {
    const fn = vi.fn(async () => "R")
    const debounced = util.debounce(fn)

    const calls = [debounced(), debounced(), debounced()]
    await vi.runAllTimersAsync()

    expect(fn).toHaveBeenCalledTimes(1)
    await expect(Promise.all(calls)).resolves.toEqual(["R", "R", "R"])
  })

  it("被防抖函数抛错时，首个调用方会收到该 rejection（D1 的改写没有吞掉它）", async () => {
    const boom = Error("boom")
    const fn = vi.fn(async () => {
      throw boom
    })
    const debounced = util.debounce(fn)

    const first = debounced()
    // 先把断言挂上去再推进定时器：否则 rejection 会有一小段无人处理，
    // vitest 会把它报成 unhandled rejection
    const asserted = expect(first).rejects.toBe(boom)
    await vi.runAllTimersAsync()

    await asserted
  })

  it("裸调用时首个调用的实际延时是 0，而不是第二个参数的默认值 5000", async () => {
    const fn = vi.fn(async () => "R")
    const debounced = util.debounce(fn)

    const call = debounced()
    // 还没推进任何时间：若延时是 5000，此刻 fn 一定没被调用
    expect(fn).not.toHaveBeenCalled()

    // 只推进 0ms。裸调用下 this 是 undefined → this?.[debounceTime] ?? 0 → 0
    await vi.advanceTimersByTimeAsync(0)

    expect(fn).toHaveBeenCalledTimes(1)
    await expect(call).resolves.toBe("R")
  })

  it("执行期间的再次调用会排队重试，并且不受前一次 rejection 影响", async () => {
    const gate = Promise.withResolvers()
    let attempt = 0
    const fn = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        await gate.promise
        throw Error("first attempt failed")
      }
      return "second attempt ok"
    })
    const debounced = util.debounce(fn)

    const first = debounced()
    const firstAsserted = expect(first).rejects.toThrow("first attempt failed")
    await vi.advanceTimersByTimeAsync(0) // 定时器触发，fn 开始执行（promise.start = true）

    // 此时 promise.start 为真 → 走排队分支：await 前一次的 promise，然后重试
    const queued = debounced()
    gate.resolve()
    // 排队分支用闭包里的 time（默认 5000）重新起定时器
    await vi.advanceTimersByTimeAsync(5000)

    await firstAsserted
    await expect(queued).resolves.toBe("second attempt ok")
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
