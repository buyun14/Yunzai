import { describe, expect, it } from "vitest"
import { ComponentType } from "../../../lib/message/component.js"
import { applyLegacyFields } from "../../../lib/message/legacy.js"
import { parseComponents } from "../../../lib/message/parse.js"

/**
 * `lib/message/legacy.js` 的单测。
 *
 * 对应的验收项（`04-message-adapter.md` §6）：给定 `Component[]`，派生的
 * `e.msg` / `e.img` / `e.atBot` / … 必须与**改造前的实现**一致。
 *
 * 改造前这里还有一组「与旧实现逐字段比对」的用例，金标准是旧 `PluginsLoader.dealEvent()`。
 * 阶段 2 第 5 步删掉旧路径后那组用例无从运行——它们守护的行为已转由
 * `tests/fixtures/pipeline/baseline-snapshots.json`（逐场景逐字段的基线快照）承担。
 * 留下的这组定点用例钉住的是那些"看起来该改、但一改就是行为变更"的地方。
 */

/** 由消息解析产出的字段 */
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
