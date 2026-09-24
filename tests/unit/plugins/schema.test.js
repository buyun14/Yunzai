import { describe, expect, it } from "vitest"
import { applyDefaults, checkSchema, normalize, validate } from "../../../lib/plugins/schema.js"

/** 收集错误路径，便于断言 */
const paths = errors => errors.map(item => item.path)

describe("checkSchema（schema 自检）", () => {
  it("接受受控子集内的写法", () => {
    expect(
      checkSchema({
        type: "object",
        required: ["a"],
        properties: {
          a: { type: "string", default: "x", minLength: 1, maxLength: 5, pattern: "^[a-z]+$" },
          b: { type: "integer", minimum: 0, maximum: 10, enum: [1, 2, 3] },
          c: { type: "array", items: { type: "boolean" } },
        },
      }),
    ).toEqual([])
  })

  it("报出不支持的 type", () => {
    const errors = checkSchema({ type: "date" })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("不支持的 type")
  })

  it("接受类型数组，并逐个元素自检", () => {
    expect(checkSchema({ type: ["string", "null"] })).toEqual([])
    expect(checkSchema({ type: ["string", "integer"] })).toEqual([])
    // 数组里的坏元素要报出来，且带定位
    const errors = checkSchema({ type: ["string", "date"] })
    expect(paths(errors)).toEqual([".type"])
    expect(errors[0].message).toContain("date")
  })

  it("空的类型数组视为写错", () => {
    expect(paths(checkSchema({ type: [] }))).toEqual([".type"])
  })

  it("报出非法 pattern", () => {
    expect(paths(checkSchema({ type: "string", pattern: "(" }))).toEqual([".pattern"])
  })

  it("报出结构写错的容器关键字", () => {
    expect(paths(checkSchema({ type: "object", properties: [] }))).toEqual([".properties"])
    expect(paths(checkSchema({ type: "array", items: "nope" }))).toEqual([".items"])
    expect(paths(checkSchema({ type: "object", required: "a" }))).toEqual([".required"])
    expect(paths(checkSchema({ enum: 1 }))).toEqual([".enum"])
  })

  it("递归检查子 schema 并给出定位路径", () => {
    const errors = checkSchema({
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "nope" } } } },
    })
    expect(paths(errors)).toEqual(["properties.a.properties.b.type"])
  })

  it("未知关键字一律忽略，不视为错误", () => {
    expect(
      checkSchema({
        type: "object",
        $ref: "#/defs/x",
        allOf: [{ type: "object" }],
        format: "email",
        "x-widget": "color",
        "x-custom": 1,
      }),
    ).toEqual([])
  })
})

describe("applyDefaults（默认值填充）", () => {
  it("填充缺失的键且不覆盖已有值", () => {
    const schema = { type: "object", properties: { a: { default: 1 }, b: { default: 2 } } }
    expect(applyDefaults(schema, { b: 9 })).toEqual({ a: 1, b: 9 })
  })

  it("值显式为 null 时不填充（null 是用户的显式选择）", () => {
    const schema = { type: "object", properties: { a: { default: 1 } } }
    expect(applyDefaults(schema, { a: null })).toEqual({ a: null })
  })

  it("递归填充嵌套对象", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { default: 1 }, c: { default: 2 } } } },
    }
    expect(applyDefaults(schema, { a: { b: 9 } })).toEqual({ a: { b: 9, c: 2 } })
  })

  it("填充数组元素的默认值", () => {
    const schema = {
      type: "array",
      items: { type: "object", properties: { a: { default: 1 }, b: { default: 2 } } },
    }
    expect(applyDefaults(schema, [{ b: 9 }, {}])).toEqual([
      { a: 1, b: 9 },
      { a: 1, b: 2 },
    ])
  })

  it("不修改入参（返回新对象）", () => {
    const schema = { type: "object", properties: { a: { default: 1 } } }
    const input = {}
    applyDefaults(schema, input)
    expect(input).toEqual({})
  })

  it("不共享 default 的引用（深拷贝）", () => {
    const schema = { type: "object", properties: { a: { default: { list: [] } } } }
    const first = applyDefaults(schema, {})
    first.a.list.push(1)
    expect(applyDefaults(schema, {}).a.list).toEqual([])
  })

  it("用户值类型不匹配时不强行改写", () => {
    const schema = { type: "object", properties: { a: { type: "integer", default: 1 } } }
    // 字符串不会因为 schema 说是 integer 就被改成 1——默认值只填 undefined
    expect(applyDefaults(schema, { a: "abc" })).toEqual({ a: "abc" })
  })
})

describe("validate（校验）", () => {
  it("type 不符时报错并带上路径", () => {
    const schema = { type: "object", properties: { a: { type: "integer" } } }
    const errors = validate(schema, { a: "x" })
    expect(paths(errors)).toEqual(["a"])
    expect(errors[0].message).toContain("期望 integer")
  })

  it("区分 null 与其他类型", () => {
    const errors = validate({ type: "object", properties: { a: { type: "string" } } }, { a: null })
    expect(errors[0].message).toContain("实际是 null")
  })

  it("required 缺失报错", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    }
    expect(paths(validate(schema, {}))).toEqual(["a"])
  })

  it("未填（undefined）不报 required 之外的错", () => {
    const schema = { type: "object", properties: { a: { type: "integer", minimum: 3 } } }
    expect(validate(schema, {})).toEqual([])
  })

  it("enum / 数值范围 / 字符串长度 / pattern", () => {
    const schema = {
      type: "object",
      properties: {
        e: { type: "string", enum: ["a", "b"] },
        n: { type: "number", minimum: 1, maximum: 2 },
        s: { type: "string", minLength: 2, maxLength: 3 },
        p: { type: "string", pattern: "^\\d+$" },
      },
    }
    const errors = validate(schema, { e: "c", n: 5, s: "a", p: "x" })
    expect(paths(errors)).toEqual(["e", "n", "s", "p"])
  })

  it("integer 不接受小数", () => {
    expect(validate({ type: "integer" }, 1.5)).toHaveLength(1)
    expect(validate({ type: "integer" }, 2)).toEqual([])
  })

  it("接受类型数组（联合类型），命中其一即通过", () => {
    const schema = { type: ["string", "null"] }
    expect(validate(schema, "abc")).toEqual([])
    expect(validate(schema, null)).toEqual([])
    const errors = validate(schema, 1)
    expect(errors).toHaveLength(1)
    // 报错文案要把两个候选都写出来，否则用户不知道该改成什么
    expect(errors[0].message).toContain("期望 string | null")
  })

  it("联合类型在数组元素上同样生效", () => {
    const schema = { type: "array", items: { type: ["string", "number"] } }
    expect(validate(schema, ["10001", 10002])).toEqual([])
    expect(paths(validate(schema, ["10001", true]))).toEqual(["[1]"])
  })

  it("嵌套数组元素的路径带下标", () => {
    const schema = {
      type: "array",
      items: { type: "object", properties: { a: { type: "integer" } } },
    }
    expect(paths(validate(schema, [{ a: 1 }, { a: "x" }]))).toEqual(["[1].a"])
  })

  it("无校验关键字的 schema 不产生错误", () => {
    expect(validate({ title: "只是标题" }, "任意值")).toEqual([])
  })
})

describe("normalize（一体入口）", () => {
  it("先填默认值再校验，填充后的值应当通过", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "integer", default: 7 } },
    }
    const { value, errors } = normalize(schema, {})
    expect(value).toEqual({ a: 7 })
    expect(errors).toEqual([])
  })

  it("用户填错时同时报错且保留用户的值", () => {
    const schema = { type: "object", properties: { a: { type: "integer", default: 7 } } }
    const { value, errors } = normalize(schema, { a: "x" })
    expect(value).toEqual({ a: "x" })
    expect(paths(errors)).toEqual(["a"])
  })
})
