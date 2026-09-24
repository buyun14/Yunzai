import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import util from "../../lib/util.js"

/**
 * `Bot` 的 Proxy 陷阱守卫（缺陷 D3）。
 *
 * `lib/bot.js` 的构造函数返回一个代理 `this.bots` 的 Proxy，其 get 陷阱未命中时
 * 会用模板字符串拼一句 trace 日志。而 `prop` 可能是 **Symbol**——框架或库常用
 * `Bot[Symbol.iterator]` / `Bot[Symbol.toStringTag]` 之类的探测来问"你有没有这个能力"。
 *
 * 模板字符串对 Symbol 求值会抛 `TypeError: Cannot convert a Symbol value to a string`，
 * 于是问题不是"日志打不出来"，而是**访问一个不存在的 Symbol 属性就直接抛异常**，
 * 且抛在 Proxy 内部、堆栈指向调用方，排查方向会被带偏。
 *
 * 修法就是 `String(prop)`。本测试锁住它：把 `String(prop)` 去掉，第一个用例立刻红。
 *
 * 这是"类型检查顺带发现的缺陷"里的一条——ESLint 看不到它，当时的单测也没有覆盖到，
 * 只有 `checkJs` 的 TS2731 提示了出来（见 baseline/static-analysis.md §3.3 D3）。
 *
 * ## 为什么对 `util.makeLog` 打桩
 *
 * 缺陷发生在**"拼出日志字符串"这一步**，也就是在 `util.makeLog` 被调用**之前**
 * ——模板字符串是实参，先求值。所以把 makeLog 换成空实现完全不削弱本测试：
 * 被验证的 Proxy 陷阱与模板字符串都还是原始实现。
 *
 * 这么做同时绕开一个**已确认但与本次修复无关**的环境差异：在 vitest 下，
 * `lib/config/log.js` 的 `setLog()` 产出的 `globalThis.logger` 读不到 `.logger`，
 * 于是 `util.isLevelEnabled` 抛
 * `TypeError: Cannot read properties of undefined (reading 'defaultLogger')`。
 * 该现象在纯 node 下不复现（同一个 import 流程用一段几行的脚本就能验证），
 * 生产运行也正常（冒烟与真机都持续打日志），且**与 `vi.stubGlobal` 无关**
 * ——把 stub 整段去掉依然复现。机制未查明，
 * 已登记为观察 O6，详见 docs/refactor/baseline/startup.md。
 */

const { default: Bot } = await import("../../lib/bot.js")

describe("Bot 的 Proxy 陷阱", () => {
  let bot

  beforeEach(() => {
    // 只把日志输出换成空实现；Proxy 与模板字符串保持原样
    vi.spyOn(util, "makeLog").mockImplementation(() => {})
    bot = new Bot()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("访问不存在的 Symbol 属性不抛异常（D3）", () => {
    // 用 well-known symbol 还原真实场景：框架/库会这样探测宿主对象
    for (const symbol of [Symbol.iterator, Symbol.toStringTag, Symbol.asyncIterator])
      expect(() => bot[symbol], `访问 ${String(symbol)} 不应抛异常`).not.toThrow()
  })

  it("访问不存在的 Symbol 属性返回 undefined", () => {
    expect(bot[Symbol("一个不存在的探测")]).toBeUndefined()
  })

  it("访问不存在的字符串属性同样不抛，并返回 undefined", () => {
    expect(() => bot.一个不存在的属性名).not.toThrow()
    expect(bot.一个不存在的属性名).toBeUndefined()
  })
})
