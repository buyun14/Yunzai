import { describe, expect, it } from "vitest"
import {
  ComponentType,
  componentTypeOf,
  isComponent,
  parseSegment,
} from "../../../lib/message/component.js"
import { parseComponents, unknownComponents } from "../../../lib/message/parse.js"

/**
 * `lib/message/component.js` 与 `parse.js` 的单测。
 *
 * 对应的验收项（`04-message-adapter.md` §6）：覆盖 §3.1 表里的**全部**组件类型
 * 以及 `Unknown` 兜底。表里的每一项都在下面显式列出——新增组件类型时这里会红，
 * 这是故意的：类型表与文档必须同步。
 */

/** 分册 §3.1 表的「段名 → 组件类型」全表 */
const SEGMENT_CASES = /** @type {Array<[string, string]>} */ ([
  ["text", ComponentType.Plain],
  ["image", ComponentType.Image],
  ["at", ComponentType.At],
  ["reply", ComponentType.Reply],
  ["file", ComponentType.File],
  ["json", ComponentType.Json],
  ["xml", ComponentType.Xml],
  ["record", ComponentType.Record],
  ["video", ComponentType.Video],
  ["face", ComponentType.Face],
  ["poke", ComponentType.Poke],
  ["forward", ComponentType.Forward],
  ["node", ComponentType.Node],
  ["music", ComponentType.Music],
  ["share", ComponentType.Share],
  ["location", ComponentType.Location],
  ["contact", ComponentType.Contact],
  ["dice", ComponentType.Dice],
  ["rps", ComponentType.Rps],
  ["shake", ComponentType.Shake],
])

describe("componentTypeOf", () => {
  for (const [segment, component] of SEGMENT_CASES)
    it(`「${segment}」映射到 ${component}`, () => {
      expect(componentTypeOf(segment)).toBe(component)
    })

  it("未登记的名字一律 Unknown，而不是抛错", () => {
    for (const name of ["mirai", "bface", "markdown", "", "Text", "TEXT"])
      expect(componentTypeOf(name)).toBe(ComponentType.Unknown)
  })

  it("非字符串输入也是 Unknown", () => {
    expect(componentTypeOf(undefined)).toBe(ComponentType.Unknown)
    expect(componentTypeOf(null)).toBe(ComponentType.Unknown)
    expect(componentTypeOf(42)).toBe(ComponentType.Unknown)
    expect(componentTypeOf({ type: "text" })).toBe(ComponentType.Unknown)
  })
})

describe("parseSegment", () => {
  it("保留原始字段，供按类型直接读", () => {
    const component = parseSegment({ type: "text", text: "#复读" })
    expect(component.type).toBe(ComponentType.Plain)
    expect(component.rawType).toBe("text")
    expect(component.text).toBe("#复读")
  })

  it("raw 是原始 segment 的同一引用", () => {
    const segment = { type: "file", name: "report.txt" }
    expect(parseSegment(segment).raw).toBe(segment)
  })

  it("type 被替换成组件类型，原名留在 rawType", () => {
    const component = parseSegment({ type: "text", text: "x" })
    expect(component.type).toBe(ComponentType.Plain)
    expect(component.rawType).toBe("text")
  })

  it("未识别的段不丢信息，原名与原始数据都在", () => {
    const segment = { type: "mirai", data: { 任意: "字段" } }
    const component = parseSegment(segment)
    expect(component.type).toBe(ComponentType.Unknown)
    expect(component.rawType).toBe("mirai")
    expect(component.raw).toBe(segment)
    expect(component.data).toEqual({ 任意: "字段" })
  })

  it("非对象段也不抛异常，名字退化成 typeof", () => {
    for (const raw of ["裸字符串", 42, true, null, undefined]) {
      const component = parseSegment(raw)
      expect(component.type).toBe(ComponentType.Unknown)
      expect(component.raw).toBe(raw)
      expect(typeof component.rawType).toBe("string")
    }
  })

  it("null 的 rawType 是 object——JS 的既有怪癖，但不会抛", () => {
    expect(parseSegment(null).rawType).toBe("object")
  })
})

describe("isComponent", () => {
  it("认自己产出的组件", () => {
    expect(isComponent(parseSegment({ type: "text", text: "x" }))).toBe(true)
  })

  it("不认原始 segment（没有 rawType / raw）", () => {
    expect(isComponent({ type: "text", text: "x" })).toBe(false)
  })

  it("不认非对象", () => {
    for (const value of [undefined, null, "text", 42]) expect(isComponent(value)).toBe(false)
  })
})

describe("parseComponents", () => {
  it("非数组输入得到空数组，而不是抛错", () => {
    for (const message of [undefined, null, "", "text", 42, {}])
      expect(parseComponents(message)).toEqual([])
  })

  it("任何段都不被丢弃，顺序不变", () => {
    const components = parseComponents([
      { type: "text", text: "#复读" },
      { type: "record", file: "voice.silk" },
      { type: "video", file: "clip.mp4" },
      { type: "forward", id: "f1" },
      { type: "poke", id: "-1" },
    ])
    expect(components.map(item => item.type)).toEqual([
      ComponentType.Plain,
      ComponentType.Record,
      ComponentType.Video,
      ComponentType.Forward,
      ComponentType.Poke,
    ])
  })

  it("返回的是新对象，改它不会影响原始 segment", () => {
    const segment = { type: "text", text: "x" }
    const [component] = parseComponents([segment])
    component.text = "y"
    expect(segment.text).toBe("x")
  })
})

describe("unknownComponents", () => {
  it("只挑出 Unknown", () => {
    const components = parseComponents([
      { type: "text", text: "x" },
      { type: "mirai", data: 1 },
      { type: "record", file: "v" },
    ])
    expect(unknownComponents(components).map(item => item.rawType)).toEqual(["mirai"])
  })

  it("没有未知段时是空数组", () => {
    expect(unknownComponents(parseComponents([{ type: "text", text: "x" }]))).toEqual([])
    expect(unknownComponents([])).toEqual([])
  })
})
