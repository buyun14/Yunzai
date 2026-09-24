import { describe, expect, it } from "vitest"
import { PERMISSION_VALUES, checkHandlers, normalizeRules } from "../../../lib/plugins/rule.js"

/**
 * 造一个最小插件实例。
 * @param {unknown} rule rule 声明
 * @returns {Record<string, unknown>} 伪插件实例
 */
const makeInstance = rule => ({ name: "测试插件", rule, run() {} })

describe("normalizeRules", () => {
  it("把字符串正则编译为 RegExp，并且是就地修改（与改造前一致）", () => {
    const instance = makeInstance([{ reg: "^#测试$", fnc: "run" }])
    const { rules, warnings } = normalizeRules(instance)
    expect(instance.rule[0].reg).toBeInstanceOf(RegExp)
    expect(rules[0].reg.test("#测试")).toBe(true)
    expect(warnings).toEqual([])
  })

  it("已经是 RegExp 的不重复编译（保持同一引用）", () => {
    const reg = /^x$/
    const instance = makeInstance([{ reg, fnc: "run" }])
    normalizeRules(instance)
    expect(instance.rule[0].reg).toBe(reg)
  })

  it("缺少 reg 时保留改造前的行为：编译成匹配任意输入的 /(?:)/，同时给出告警", () => {
    // 这是刻意保留的语义——不写 reg 就等于只按 rule.event 匹配，
    // 收紧它属于行为变更，需要在 01-plugin-contract.md 登记后再做
    const instance = makeInstance([{ event: "notice.group.increase", fnc: "run" }])
    const { warnings } = normalizeRules(instance)
    expect(instance.rule[0].reg.test("任意内容")).toBe(true)
    expect(warnings.some(text => text.includes("没有 reg"))).toBe(true)
  })

  it("非法正则只告警、不抛出", () => {
    const { warnings } = normalizeRules(makeInstance([{ reg: "(", fnc: "run" }]))
    expect(warnings.some(text => text.includes("不是合法正则"))).toBe(true)
  })

  it("fnc 缺失或不是实例方法时告警", () => {
    expect(normalizeRules(makeInstance([{ reg: "^a$" }])).warnings.join()).toContain("缺少 fnc")
    expect(normalizeRules(makeInstance([{ reg: "^a$", fnc: "nope" }])).warnings.join()).toContain(
      "不是插件实例上的方法",
    )
  })

  it("permission 为未知取值时告警（阶段 1 不改变其行为）", () => {
    const { warnings } = normalizeRules(
      makeInstance([{ reg: "^a$", fnc: "run", permission: "mater" }]),
    )
    expect(warnings.join()).toContain("mater")
  })

  it("已知的 permission 取值都不告警", () => {
    const noisy = PERMISSION_VALUES.filter(
      permission =>
        normalizeRules(makeInstance([{ reg: "^a$", fnc: "run", permission }])).warnings.length !==
        0,
    )
    expect(noisy).toEqual([])
  })

  it("rule 形态不对时返回空列表而不抛出", () => {
    expect(normalizeRules({ name: "x", rule: "nope" }).rules).toEqual([])
    expect(normalizeRules({ name: "x" }).rules).toEqual([])
    expect(normalizeRules({ name: "x", rule: [null, 1] }).rules).toEqual([])
    expect(normalizeRules({ name: "x", rule: "nope" }).warnings).toHaveLength(1)
    expect(normalizeRules({ name: "x", rule: [null, 1] }).warnings).toHaveLength(2)
  })
})

describe("checkHandlers", () => {
  it("正常声明不告警", () => {
    const instance = { name: "x", handler: { onMsg: { fn: "onMsg", key: "message" } }, onMsg() {} }
    expect(checkHandlers(instance)).toEqual([])
  })

  it("缺少 fn 或 fn 不是实例方法时告警", () => {
    expect(checkHandlers({ name: "x", handler: { a: { key: "message" } } }).join()).toContain(
      "缺少 fn",
    )
    expect(
      checkHandlers({ name: "x", handler: { a: { fn: "nope", key: "message" } } }).join(),
    ).toContain("不是插件实例上的方法")
  })

  it("handler 形态不对时告警而不抛出", () => {
    expect(checkHandlers({ name: "x", handler: "nope" })).toHaveLength(1)
    expect(checkHandlers({ name: "x", handler: { a: null } })).toHaveLength(1)
    expect(checkHandlers({ name: "x" })).toEqual([])
  })
})
