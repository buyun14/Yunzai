import { describe, expect, it } from "vitest"
import { checkHostVersion, isValidRange } from "../../../lib/plugins/version.js"

const HOST = "3.1.3"

describe("isValidRange", () => {
  it("接受常见 range 写法", () => {
    for (const range of [">=3.1.0 <4.0.0", "^3.1.0", "~3.1.0", "3.1.3", ">=3.1.0 || >=4.0.0"])
      expect(isValidRange(range), range).toBe(true)
  })

  it("拒绝垃圾输入", () => {
    for (const range of ["随便写的", "", "not-a-version", 123, null, undefined])
      expect(isValidRange(range), String(range)).toBe(false)
  })
})

describe("checkHostVersion", () => {
  it("未声明范围时放行（存量插件不受影响）", () => {
    expect(checkHostVersion(undefined, HOST)).toEqual({ ok: true })
    expect(checkHostVersion("", HOST)).toEqual({ ok: true })
    expect(checkHostVersion(null, HOST)).toEqual({ ok: true })
  })

  it("满足范围时放行", () => {
    expect(checkHostVersion(">=3.1.0 <4.0.0", HOST)).toEqual({ ok: true })
    expect(checkHostVersion("3.1.3", HOST)).toEqual({ ok: true })
  })

  it("不满足时拒绝，并同时给出要求与当前版本", () => {
    const result = checkHostVersion(">=4.0.0", HOST)
    expect(result.ok).toBe(false)
    expect(result.invalid).toBeUndefined()
    expect(result.reason).toContain(">=4.0.0")
    expect(result.reason).toContain(HOST)
  })

  it("范围本身不合法时标记 invalid（与「不满足」区分开，便于给出不同提示）", () => {
    const result = checkHostVersion("随便写的", HOST)
    expect(result).toMatchObject({ ok: false, invalid: true })
    expect(result.reason).toContain("合法 semver range")
  })

  it("宿主版本无法解析时放行并说明原因", () => {
    // 本仓版本号有问题不应该把用户所有插件一次性禁用
    const result = checkHostVersion(">=3.1.0", "dev")
    expect(result.ok).toBe(true)
    expect(result.reason).toContain("无法解析宿主版本")
  })

  it("宿主版本带预发布标记时启用 includePrerelease", () => {
    // fork 自用版本形如 4.0.0-dev.0 时，>=3.1.0 这类范围必须仍然能匹配
    expect(checkHostVersion(">=3.1.0", "4.0.0-dev.0").ok).toBe(true)
  })

  it("宿主为正式版本时不因预发布逻辑放宽上界", () => {
    expect(checkHostVersion("<4.0.0", "4.0.0").ok).toBe(false)
  })
})
