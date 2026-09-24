import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  adapterById,
  adapterByPath,
  adapters,
  registerAdapter,
  resetAdapters,
} from "../../../lib/adapter/registry.js"
import { builtinAdapterIds, capabilitiesOf, supports } from "../../../lib/adapter/capabilities.js"
import util from "../../../lib/util.js"

/**
 * 适配器注册表（`lib/adapter/registry.js`）与能力表（`lib/adapter/capabilities.js`）。
 *
 * 对应的验收项（`04-message-adapter.md` §6）：`Bot.adapter` 的索引在 `push` 之后
 * 立即可用，且有单测覆盖 `path` 去重；能力表至少 2 个适配器完成声明。
 *
 * `lib/bot.js` 的 import 会经 `config/init.js` 触发 `setLog()`，因此对
 * `util.makeLog` 打桩——理由与 O6 的说明同 `bot-proxy.test.js`。
 */

const { default: Bot } = await import("../../../lib/bot.js")

beforeEach(() => {
  resetAdapters()
  vi.spyOn(util, "makeLog").mockImplementation(() => {})
})

describe("registry：登记与查询", () => {
  it("按 path 与 id 都能查到", () => {
    registerAdapter({ id: "QQ", path: "OneBotv11" })
    expect(adapterByPath("OneBotv11").id).toBe("QQ")
    expect(adapterById("QQ").path).toBe("OneBotv11")
  })

  it("非对象输入被忽略，不抛异常", () => {
    for (const value of [undefined, null, "x", 42]) registerAdapter(value)
    expect(adapters()).toEqual([])
  })

  it("id 可能重复，后登记的覆盖先登记的（精确身份请用 path）", () => {
    registerAdapter({ id: "QQ", path: "OneBotv11" })
    registerAdapter({ id: "QQ", path: "ComWeChat" })
    expect(adapterById("QQ").path).toBe("ComWeChat")
    expect(adapterByPath("OneBotv11").path).toBe("OneBotv11")
  })

  it("没有 path 的适配器进不了 byPath，但仍能按 id 查到", () => {
    registerAdapter({ id: "X" })
    expect(adapterByPath("X")).toBeUndefined()
    expect(adapterById("X")).toEqual({ id: "X" })
  })

  it("查不到时返回 undefined，而不是抛错", () => {
    expect(adapterByPath("不存在")).toBeUndefined()
    expect(adapterById("不存在")).toBeUndefined()
  })
})

describe("registry：与 Bot.adapter 的 push 同步", () => {
  it("push 之后索引立即可用", () => {
    const bot = new Bot()
    bot.adapter.push({ id: "A", path: "a" }, { id: "B", path: "b" })

    expect(bot.adapter).toHaveLength(2)
    expect(adapterByPath("a").id).toBe("A")
    expect(adapterByPath("b").id).toBe("B")
    expect(adapters()).toHaveLength(2)
  })

  it("同 path 被去重，且索引不会被后来的覆盖", () => {
    const bot = new Bot()
    bot.adapter.push({ id: "A", path: "a" })
    bot.adapter.push({ id: "A2", path: "a" })

    expect(bot.adapter).toHaveLength(1)
    expect(bot.adapter[0].id).toBe("A")
    // 索引与数组一致：被去重的那个没有进索引
    expect(adapterByPath("a").id).toBe("A")
  })

  it("没有 path 的适配器照样入数组，也进 id 索引", () => {
    const bot = new Bot()
    bot.adapter.push({ id: "NoPath" })

    expect(bot.adapter).toHaveLength(1)
    expect(adapterById("NoPath")).toBeDefined()
  })
})

describe("capabilities：三态返回值", () => {
  it("已登记的适配器给出确定答案", () => {
    expect(supports("QQ", "forward")).toBe(true)
    expect(supports("QQ", "poke")).toBe(false)
    expect(supports("Satori", "video")).toBe(true)
  })

  it("未登记的适配器一律是 undefined（未知），不是 false", () => {
    // 这条是刻意的：把"未知"当成"不支持"会让功能静默消失。
    for (const id of ["Milky", "OPQBot", "ComWeChat", "GSUIDCore", "stdin", "不存在"])
      expect(supports(id, "forward")).toBeUndefined()
  })

  it("能力名不认识时也是 undefined", () => {
    expect(supports("QQ", "不存在的能力")).toBeUndefined()
  })

  it("适配器对象优先看它自己的 capabilities 声明", () => {
    const declared = { forward: true, 自定义: true }
    expect(capabilitiesOf({ id: "QQ", capabilities: declared })).toBe(declared)
    expect(supports({ id: "Milky", capabilities: { poke: true } }, "poke")).toBe(true)
  })

  it("非对象、无 id 的输入不会抛错", () => {
    expect(capabilitiesOf(undefined)).toBeUndefined()
    expect(capabilitiesOf(null)).toBeUndefined()
    expect(capabilitiesOf({})).toBeUndefined()
    expect(supports({}, "forward")).toBeUndefined()
  })

  it("内置表覆盖了 2 个适配器（分册 §6 的验收下限）", () => {
    expect(builtinAdapterIds().sort()).toEqual(["QQ", "Satori"])
  })

  it("适配器自己声明了 capabilities 时，内置表的值就不会被用到", () => {
    // 这是刻意留的：OneBotv11 / Satori 源码里也各写了一份同样的声明。
    // 两份值不一致时，答案以**适配器自己的**为准，所以重复不会导致错误答案，
    // 只会在有人问 QQ 的能力时用到内置表那一份（例如适配器还没注册）。
    expect(capabilitiesOf({ id: "QQ", capabilities: {} })).toEqual({})
    expect(capabilitiesOf("QQ").forward).toBe(true)
  })
})
