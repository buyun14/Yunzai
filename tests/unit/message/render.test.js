import { describe, expect, it } from "vitest"
import { unsupportedComponents } from "../../../lib/adapter/capabilities.js"
import { ComponentType } from "../../../lib/message/component.js"
import { parseComponents } from "../../../lib/message/parse.js"
import {
  capabilityOfComponent,
  renderComponent,
  renderComponents,
} from "../../../lib/message/render.js"

/**
 * `lib/message/render.js` 与能力表的 `unsupportedComponents()`。
 *
 * 对应的验收项（`04-message-adapter.md` §6）：发送侧能把组件转回适配器认识的段，
 * 且能力表能判断"不支持"，同时**不把"未知"当成"不支持"**。
 */

describe("renderComponents：往返一致", () => {
  it("来自真实 segment 的组件渲染后是**同一个对象**", () => {
    const segments = [
      { type: "text", text: "#复读" },
      { type: "image", url: "https://example.invalid/1.png" },
      { type: "at", qq: 12345 },
    ]
    const rendered = renderComponents(parseComponents(segments))

    expect(rendered).toHaveLength(3)
    for (const [index, segment] of rendered.entries()) expect(segment).toBe(segments[index])
  })

  it("未识别的段也原样送回（不丢信息）", () => {
    const segments = [{ type: "mirai", data: { 任意: 1 } }]
    expect(renderComponents(parseComponents(segments))[0]).toBe(segments[0])
  })

  it("顺序与长度不变", () => {
    const segments = [
      { type: "text", text: "a" },
      { type: "record", file: "v" },
    ]
    expect(renderComponents(parseComponents(segments)).map(item => item.type)).toEqual([
      "text",
      "record",
    ])
  })

  it("非数组输入渲染成空数组", () => {
    expect(renderComponents(parseComponents(undefined))).toEqual([])
  })
})

describe("renderComponent：手工构造的组件", () => {
  it("按原始段名重建", () => {
    expect(
      renderComponent({ type: ComponentType.Plain, rawType: "text", raw: undefined, text: "hi" }),
    ).toEqual({ type: "text", text: "hi" })
  })

  it("没有 rawType 时按组件类型反查段名", () => {
    expect(renderComponent({ type: ComponentType.Image, url: "u" })).toEqual({
      type: "image",
      url: "u",
    })
  })

  it("既没有 rawType 也不认识类型时，段名退化成组件类型", () => {
    expect(renderComponent({ type: "自定义", 字段: 1 })).toEqual({ type: "自定义", 字段: 1 })
  })
})

describe("capabilityOfComponent", () => {
  const CASES = /** @type {Array<[string, string|undefined]>} */ ([
    [ComponentType.Plain, "text"],
    [ComponentType.Image, "image"],
    [ComponentType.At, "at"],
    [ComponentType.Reply, "reply"],
    [ComponentType.Record, "record"],
    [ComponentType.Video, "video"],
    [ComponentType.Forward, "forward"],
    [ComponentType.Node, "forward"],
    [ComponentType.Poke, "poke"],
    [ComponentType.Json, "json"],
    [ComponentType.Xml, "json"],
    [ComponentType.Face, undefined],
    [ComponentType.Unknown, undefined],
  ])

  for (const [type, capability] of CASES)
    it(`${type} → ${capability ?? "无"}`, () => {
      expect(capabilityOfComponent({ type })).toBe(capability)
    })
})

describe("unsupportedComponents：只认「确定不支持」", () => {
  it("挑出声明为 false 的组件", () => {
    const components = parseComponents([
      { type: "text", text: "x" },
      { type: "poke", id: "-1" },
    ])
    expect(unsupportedComponents("QQ", components).map(item => item.rawType)).toEqual(["poke"])
  })

  it("「未知」不算不支持（未登记的适配器）", () => {
    const components = parseComponents([{ type: "record", file: "v" }])
    expect(unsupportedComponents("Milky", components)).toEqual([])
  })

  it("没有对应能力的组件类型不参与判断", () => {
    const components = parseComponents([{ type: "face", id: "1" }])
    expect(unsupportedComponents("QQ", components)).toEqual([])
  })

  it("空数组、未知适配器都不抛错", () => {
    expect(unsupportedComponents("QQ", [])).toEqual([])
    expect(unsupportedComponents(undefined, parseComponents([{ type: "poke" }]))).toEqual([])
  })

  it("适配器的 capabilities 声明优先于内置表", () => {
    const components = parseComponents([{ type: "poke", id: "-1" }])
    const adapter = { id: "QQ", capabilities: { poke: true } }
    expect(unsupportedComponents(adapter, components)).toEqual([])
  })
})
