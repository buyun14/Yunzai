import { describe, expect, it, vi } from "vitest"
import { ComponentType } from "../../../lib/message/component.js"
import { applyLegacyFields } from "../../../lib/message/legacy.js"
import { parseComponents } from "../../../lib/message/parse.js"
import { PluginsLoader } from "../../../lib/plugins/loader.js"
import { listFixtures, makeEvent } from "../../helpers/events.js"

/**
 * `lib/message/legacy.js` 的单测。
 *
 * 对应的验收项（`04-message-adapter.md` §6）：给定 `Component[]`，派生的
 * `e.msg` / `e.img` / `e.atBot` / … 必须与**改造前的实现**一致——
 * 这里直接用旧路径 `PluginsLoader.dealEvent()` 当金标准，跑全部事件样本。
 *
 * 另有一组定点用例，专门钉住那些"看起来该改、但一改就是行为变更"的地方。
 */

// 与 shadow.test.js 同样的理由：`lib/plugins/loader.js` 会静态拉进 runtime，
// 而 runtime 又会拉进 puppeteer 与渲染器加载器——后者的模块顶层就用了全局 `logger`，
// 而全局替身是 `beforeAll` 才装的，于是导入阶段就炸。跑 `dealEvent` 用不到 runtime。
vi.mock("../../../lib/plugins/runtime.js", () => ({ default: { init: async () => {} } }))

/** 由消息解析产出的字段（`dealEvent` 的这一段与本模块的职责完全相同） */
const DERIVED_FIELDS = ["msg", "img", "at", "atBot", "reply_id", "file"]

/**
 * 取出待比较的字段。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @returns {Record<string, unknown>} 字段子集
 */
function derived(event) {
  return Object.fromEntries(DERIVED_FIELDS.map(field => [field, event[field]]))
}

/**
 * 旧实现：只跑 `PluginsLoader.dealEvent()` 的解析段。
 *
 * `botAlias` 清空是刻意的：`dealEvent` 在解析之后还会做别名剥离，那一步已经由
 * `NormalizeStage.stripAlias()` 承担，不属于 `legacy.js` 的职责。清空之后
 * 别名循环成为空操作，`msg` 停在"刚解析完"的状态，两边才可比。
 *
 * @param {string} fixture 样本名
 * @returns {Record<string, unknown>} 字段子集
 */
function legacyDerived(fixture) {
  const loader = new PluginsLoader()
  const { event } = makeEvent(fixture)
  loader.dealEvent(event, { botAlias: [], onlyReplyAt: 0 })
  return derived(event)
}

/**
 * 新实现：`parseComponents()` + `applyLegacyFields()`。
 *
 * @param {string} fixture 样本名
 * @param {{ slashToHash?: boolean }} [options] 传给 `applyLegacyFields`
 * @returns {Record<string, unknown>} 字段子集
 */
function newDerived(fixture, options) {
  const { event } = makeEvent(fixture)
  applyLegacyFields(event, parseComponents(event.message), options)
  return derived(event)
}

/**
 * 在裸消息段上跑一遍派生，并返回整个事件对象（用于需要看函数、引用的用例）。
 *
 * @param {unknown} message 原始 `message` 字段
 * @param {Record<string, unknown>} [extra] 事件上的其它字段
 * @param {{ slashToHash?: boolean }} [options] 传给 `applyLegacyFields`
 * @returns {Record<string, unknown>} 事件对象
 */
function derive(message, extra = {}, options = {}) {
  const event = { message, ...extra }
  applyLegacyFields(event, parseComponents(message), options)
  return event
}

describe("与旧实现（PluginsLoader.dealEvent）逐字段一致", () => {
  for (const fixture of listFixtures())
    it(fixture, () => {
      expect(newDerived(fixture)).toEqual(legacyDerived(fixture))
    })

  it("样本清单非空，否则这条用例是假的", () => {
    expect(listFixtures().length).toBeGreaterThanOrEqual(14)
  })
})

describe("定点用例：语义陷阱", () => {
  it("纯图片消息的 msg 保持 undefined，而不是空串", () => {
    // `(e.msg || "")` 累加只在遇到文本段时发生。改成 `?? ""` 会让 e.msg 变成 ""，
    // 那是行为变更（插件里 `if (e.msg)` 的判断结果会跟着变）。
    const event = derive([{ type: "image", url: "https://example.invalid/1.png" }])
    expect(event.msg).toBeUndefined()
    expect(event.img).toEqual(["https://example.invalid/1.png"])
  })

  it("已有 img 数组时追加，而不是覆盖", () => {
    const event = derive([{ type: "image", url: "b.png" }], { img: ["a.png"] })
    expect(event.img).toEqual(["a.png", "b.png"])
  })

  it("多个文本段按顺序拼接，且每段各自归一化", () => {
    const event = derive([
      { type: "text", text: "第一段 " },
      { type: "text", text: " 第二段" },
    ])
    expect(event.msg).toBe("第一段第二段")
  })

  it("前导 / 在 slashToHash 缺省（true）时转成 #", () => {
    expect(derive([{ type: "text", text: "/复读" }]).msg).toBe("#复读")
  })

  it("slashToHash 为 false 时保留原样的 /", () => {
    expect(derive([{ type: "text", text: "/复读" }], {}, { slashToHash: false }).msg).toBe("/复读")
  })

  it('at 命中 self_id 时置 atBot（宽松比较，"123" 与 123 都算）', () => {
    expect(derive([{ type: "at", qq: 12345 }], { self_id: 12345 }).atBot).toBe(true)
    expect(derive([{ type: "at", qq: "12345" }], { self_id: 12345 }).atBot).toBe(true)
  })

  it("at 不命中时写入 at，多个 at 以最后的为准", () => {
    const event = derive(
      [
        { type: "at", qq: 111 },
        { type: "at", qq: 222 },
      ],
      { self_id: 12345 },
    )
    expect(event.at).toBe(222)
    expect(event.atBot).toBeUndefined()
  })

  it("reply 段写入 reply_id，并在 group 上挂 getReply", async () => {
    const event = derive([{ type: "reply", id: 1000 }], {
      group: { getMsg: async id => ({ id }) },
    })
    expect(event.reply_id).toBe(1000)
    await expect(/** @type {() => Promise<unknown>} */ (event.getReply)()).resolves.toEqual({
      id: 1000,
    })
  })

  it("没有 group 时退回 friend 的 getMsg", async () => {
    const event = derive([{ type: "reply", id: 7 }], {
      friend: { getMsg: async id => ({ id }) },
    })
    await expect(/** @type {() => Promise<unknown>} */ (event.getReply)()).resolves.toEqual({
      id: 7,
    })
  })

  it("getReply 读到的是调用时的 reply_id，不是段里捕获的 id", async () => {
    // 旧实现闭包里读的是 `event.reply_id`，即调用那一刻的值。改成捕获 `id`
    // 会让"插件中途改了 reply_id"这类场景行为不同。
    const event = derive([{ type: "reply", id: 1000 }], {
      group: { getMsg: async id => ({ id }) },
    })
    event.reply_id = 2000
    await expect(/** @type {() => Promise<unknown>} */ (event.getReply)()).resolves.toEqual({
      id: 2000,
    })
  })

  it("file 段整体写入 e.file，且是**同一个对象**（引用相等）", () => {
    const segment = { type: "file", name: "report.txt", file: "f1" }
    const event = derive([segment])
    expect(event.file).toBe(segment)
  })

  it("json / xml 的字符串载荷直接拼接，对象载荷被序列化", () => {
    expect(derive([{ type: "json", data: '{"a":1}' }]).msg).toBe('{"a":1}')
    expect(derive([{ type: "json", data: { a: 1 } }]).msg).toBe('{"a":1}')
    expect(derive([{ type: "xml", data: "<a/>" }]).msg).toBe("<a/>")
  })

  it("不被识别的段不产生任何字段", () => {
    for (const type of ["record", "video", "forward", "poke", "mirai", "bface"]) {
      const event = derive([{ type, file: "x", id: "y", data: "z" }])
      expect(derived(event)).toEqual({
        msg: undefined,
        img: undefined,
        at: undefined,
        atBot: undefined,
        reply_id: undefined,
        file: undefined,
      })
    }
  })

  it("record 不会被当成 file", () => {
    expect(derive([{ type: "record", file: "voice.silk" }]).file).toBeUndefined()
  })

  it("组件类型是组件模型的取值，不是原始段名", () => {
    const [component] = parseComponents([{ type: "text", text: "x" }])
    expect(component.type).toBe(ComponentType.Plain)
    expect(component.type).not.toBe("text")
  })

  it("message 缺失或不是数组时什么都不写", () => {
    for (const message of [undefined, null, "", 42, {}]) {
      const event = derive(message)
      expect(derived(event)).toEqual({
        msg: undefined,
        img: undefined,
        at: undefined,
        atBot: undefined,
        reply_id: undefined,
        file: undefined,
      })
    }
  })
})
