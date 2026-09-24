import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { describe, expect, it } from "vitest"
import { HOST_SCHEMAS, UNMODELED, isUnmodeled, schemaFor, schemaNames } from "../../../lib/config/host-schema.js"
import { checkSchema, normalize, validate } from "../../../lib/plugins/schema.js"

/**
 * 宿主配置 schema（阶段 5 §3.2，下游消费者是阶段 6 的 WebUI 表单）。
 *
 * 这里最有价值的一条是「出厂默认配置必须通过自己的 schema」：schema 与
 * `config/default_config/*.yaml` 是两份手工维护的东西，加一个配置项却忘了同步 schema、
 * 或者把 schema 的类型写错（该 `integer` 写成 `string`），**都不会有任何运行期报错**
 * ——WebUI 上只会表现为"这个字段不见了"或"改不动"。所以必须有一条测试盯着它们一致。
 */

/** 仓库根 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))

/** 出厂默认配置目录 */
const DEFAULTS_DIR = path.join(ROOT, "config", "default_config")

/**
 * 列出出厂默认配置目录下的全部 yaml 文件名。
 *
 * @returns {Promise<string[]>} 文件名（已排序）
 */
async function listDefaultConfigs() {
  const entries = await fs.readdir(DEFAULTS_DIR, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

/**
 * 读一份出厂默认配置。
 *
 * @param {string} name 文件名
 * @returns {Promise<unknown>} 解析后的 yaml
 */
async function readDefault(name) {
  return YAML.parse(await fs.readFile(path.join(DEFAULTS_DIR, name), "utf8"))
}

describe("schema 表自身", () => {
  it("每个 schema 都通过受控子集的自检（写法合法）", () => {
    for (const [name, schema] of Object.entries(HOST_SCHEMAS)) {
      const errors = checkSchema(schema)
      expect(errors, `${name} 的 schema 自检未通过：${JSON.stringify(errors)}`).toEqual([])
    }
  })

  it("每个 schema 顶层都是 object 且有 title", () => {
    for (const [name, schema] of Object.entries(HOST_SCHEMAS)) {
      expect(schema.type, `${name} 的顶层 type 必须是 object`).toBe("object")
      expect(typeof schema.title, `${name} 缺少 title`).toBe("string")
      expect(schema.title.length, `${name} 的 title 不能为空`).toBeGreaterThan(0)
    }
  })

  it("每个字段都有 title（WebUI 靠它当标签）", () => {
    /**
     * 递归收集缺少 title 的字段路径。
     *
     * @param {object} schema 当前 schema
     * @param {string} prefix 路径前缀
     * @returns {string[]} 缺 title 的路径
     */
    function missingTitles(schema, prefix) {
      const result = []
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const where = `${prefix}.${key}`
        if (typeof sub.title !== "string" || !sub.title) result.push(where)
        if (sub.properties) result.push(...missingTitles(sub, where))
      }
      return result
    }

    for (const [name, schema] of Object.entries(HOST_SCHEMAS)) {
      const missing = missingTitles(schema, name)
      expect(missing, `${name} 有字段缺少 title`).toEqual([])
    }
  })

  it("每个字段的 default 都满足自己的 schema", () => {
    /**
     * 递归校验 `properties` 的 default。
     *
     * 默认值写错类型（如 `minimum: 0` 却给了 `null`）在运行期看不出来，
     * 但 WebUI 上会渲染成一个填不进去的字段。
     *
     * @param {object} schema 当前 schema
     * @param {string} prefix 路径前缀
     * @returns {Array<{ path: string, message: string }>} 问题列表
     */
    function checkDefaults(schema, prefix) {
      const errors = []
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const where = `${prefix}.${key}`
        if ("default" in sub) {
          const found = validate({ ...sub, default: undefined }, sub.default, where)
          for (const item of found) errors.push(item)
        }
        if (sub.properties) errors.push(...checkDefaults(sub, where))
      }
      return errors
    }

    for (const [name, schema] of Object.entries(HOST_SCHEMAS)) {
      const errors = checkDefaults(schema, name)
      expect(errors, `${name} 的 default 与自己声明的类型不符`).toEqual([])
    }
  })

  it("schemaNames() 与 HOST_SCHEMAS 的键一致且有序", () => {
    expect(schemaNames()).toEqual(Object.keys(HOST_SCHEMAS).sort())
  })

  it("schemaFor / isUnmodeled 对未建模文件给出明确答案", () => {
    expect(schemaFor("bot.yaml")).toBe(HOST_SCHEMAS["bot.yaml"])
    expect(schemaFor("group.yaml")).toBeUndefined()
    expect(isUnmodeled("group.yaml")).toBe(true)
    expect(isUnmodeled("bot.yaml")).toBe(false)
    // 两个名单不允许重叠：一个文件要么建模、要么明确不建模
    for (const name of Object.keys(UNMODELED)) expect(schemaFor(name)).toBeUndefined()
  })

  it("不认识的属性名不会被当成已建模", () => {
    // 防原型链误判（Object.hasOwn 而不是 `in` / 直接取值）
    expect(schemaFor("toString")).toBeUndefined()
    expect(isUnmodeled("constructor")).toBe(false)
  })
})

describe("与出厂默认配置的一致性", () => {
  it("每个出厂 yaml 要么被建模、要么在 UNMODELED 里（不许静默漏掉）", async () => {
    const files = await listDefaultConfigs()
    const modeled = Object.keys(HOST_SCHEMAS)
    const unmodeled = Object.keys(UNMODELED)

    expect(files.length, "默认配置目录里一个 yaml 都没有，测试本身失效了").toBeGreaterThan(0)

    const forgotten = files.filter(name => !modeled.includes(name) && !unmodeled.includes(name))
    expect(forgotten, "这些配置文件既没建模也没登记进 UNMODELED").toEqual([])

    const stale = [...modeled, ...unmodeled].filter(name => !files.includes(name))
    expect(stale, "这些名字在 schema 里，但默认配置目录下没有对应文件").toEqual([])
  })

  it("出厂默认配置逐一通过自己的 schema（填默认值后零错误）", async () => {
    for (const name of Object.keys(HOST_SCHEMAS)) {
      const actual = await readDefault(name)
      const { errors } = normalize(HOST_SCHEMAS[name], actual)
      expect(errors, `${name} 的出厂默认值没通过自己的 schema：${JSON.stringify(errors)}`).toEqual([])
    }
  })

  it("schema 声明的 default 与出厂默认配置的值一致", async () => {
    /**
     * 递归比对「schema 里的 default」与「yaml 里的实际值」。
     *
     * 只比对 schema **显式声明了** default 的字段：没声明 default 的字段
     * （如 `https`、`auth` 这类交给用户填的）不参与，避免把"没写"当成"不一致"。
     *
     * @param {object} schema 当前 schema
     * @param {Record<string, unknown>} actual 当前层的实际值
     * @param {string} prefix 路径前缀
     * @returns {string[]} 不一致的路径描述
     */
    function compare(schema, actual, prefix) {
      const diffs = []
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const where = `${prefix}.${key}`
        if ("default" in sub && actual && Object.hasOwn(actual, key)) {
          const a = JSON.stringify(sub.default)
          const b = JSON.stringify(actual[key])
          if (a !== b) diffs.push(`${where}: schema=${a} yaml=${b}`)
        }
        if (sub.properties) diffs.push(...compare(sub, actual?.[key], where))
      }
      return diffs
    }

    for (const name of Object.keys(HOST_SCHEMAS)) {
      const actual = await readDefault(name)
      const diffs = compare(HOST_SCHEMAS[name], actual, name)
      expect(diffs, `${name} 的 schema 默认值与出厂 yaml 不一致`).toEqual([])
    }
  })

  it("UNMODELED 的每一项都写明了原因", () => {
    for (const [name, reason] of Object.entries(UNMODELED)) {
      expect(typeof reason, `${name} 的原因必须是字符串`).toBe("string")
      expect(reason.length, `${name} 的原因不能是空的`).toBeGreaterThan(10)
    }
  })
})

describe("若干关键字段的语义被如实建模", () => {
  it("bot.yaml 的间隔类配置允许 0（0 = 不启用，不能设成 minimum 1）", () => {
    const props = HOST_SCHEMAS["bot.yaml"].properties
    for (const key of ["update_time", "restart_time", "online_msg_exp"]) {
      expect(props[key].minimum, `${key} 应当允许 0`).toBe(0)
      expect(validate(props[key], 0), `${key} 取 0 应当合法`).toEqual([])
    }
  })

  it("可空字段接受 null 也接受真实值（联合类型）", () => {
    const props = HOST_SCHEMAS["bot.yaml"].properties
    expect(validate(props.chromium_path, null)).toEqual([])
    expect(validate(props.chromium_path, "/usr/bin/chromium")).toEqual([])
    expect(validate(props.chromium_path, 123)).toHaveLength(1)
  })

  it("log_level 只接受已知等级", () => {
    const level = HOST_SCHEMAS["bot.yaml"].properties.log_level
    expect(validate(level, "info")).toEqual([])
    expect(validate(level, "verbose")).toHaveLength(1)
  })

  it("端口有范围约束，0 与 70000 都不合法", () => {
    const port = HOST_SCHEMAS["server.yaml"].properties.port
    expect(validate(port, 2536)).toEqual([])
    expect(validate(port, 0)).toHaveLength(1)
    expect(validate(port, 70000)).toHaveLength(1)
  })

  it("auth 与 https 标成 raw（不渲染成表单）", () => {
    const props = HOST_SCHEMAS["server.yaml"].properties
    expect(props.auth["x-widget"]).toBe("raw")
    expect(props.https["x-widget"]).toBe("raw")
  })

  it("敏感字段标成 password", () => {
    expect(HOST_SCHEMAS["redis.yaml"].properties.password["x-widget"]).toBe("password")
    expect(HOST_SCHEMAS["satori.yaml"].properties.token["x-widget"]).toBe("password")
    expect(HOST_SCHEMAS["milky.yaml"].properties.access_token["x-widget"]).toBe("password")
  })

  it("auth 的默认值既不遮也不能是对象字面量之外的东西", () => {
    // auth 默认 null（未配置），此时 serverAuth 完全放行——这是既有语义，schema 不该改它
    expect(HOST_SCHEMAS["server.yaml"].properties.auth.default).toBeNull()
    expect(validate(HOST_SCHEMAS["server.yaml"].properties.auth, { Authorization: "t" })).toEqual([])
  })
})
