/**
 * JSON Schema 受控子集的校验与默认值填充。
 *
 * ## 为什么是"受控子集"而不是全量 JSON Schema
 *
 * 这份实现需要同时运行在 Node（插件加载时校验配置）与浏览器（WebUI 渲染表单后校验），
 * 所以刻意不引入 `ajv`：体积可控、行为在两端完全一致、无编译期开销。
 *
 * ## 支持的子集
 *
 * | 关键字 | 说明 |
 * |---|---|
 * | `type` | `object` `array` `string` `number` `integer` `boolean` `null`；也可以是**类型数组**（联合类型，如 `["string","null"]`），命中其一即通过 |
 * | `properties` | 递归，仅用于 `object` |
 * | `items` | 仅用于 `array` |
 * | `required` | 仅用于 `object` |
 * | `default` | 缺失时填充；数组元素与嵌套对象同样支持 |
 * | `enum` | 值必须严格等于其中之一 |
 * | `minimum` / `maximum` | 数值范围 |
 * | `minLength` / `maxLength` | 字符串长度 |
 * | `pattern` | 字符串正则 |
 * | `title` / `description` | 仅作展示说明，不参与校验 |
 * | `x-widget` | 仅作展示提示（如 `textarea`、`color`、`password`、`select`、`raw`），不参与校验 |
 *
 * ## 不支持的关键字
 *
 * `$ref`、`allOf`、`anyOf`、`oneOf`、`format`、`patternProperties`、
 * `additionalProperties`、`dependencies` 等一律**忽略**（不报错）。
 * 这样 schema 里可以携带额外的自定义提示，不会因为宿主不认识而判定配置非法。
 *
 * 本模块**不得**引入任何 Node 专有 API（`node:fs`、`process` 等）。
 */

/** 支持的 `type` 取值 */
export const SUPPORTED_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"]

/** 参与校验的关键字（用于快速判断一个 schema 是否"有话要说"） */
const VALIDATING_KEYWORDS = [
  "type",
  "properties",
  "items",
  "required",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]

/**
 * 判断值是否为普通对象（排除 null 与数组）。
 *
 * 返回 TS 类型谓词而不是 `boolean`：本模块的入参都是"从 JSON 解析出来的任意值"，
 * 靠谓词收窄比在调用处到处写类型断言更安全。
 *
 * @param {unknown} value 待判断的值
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * 判断值是否满足给定类型。
 *
 * `type` 也可以是**类型数组**（JSON Schema 的联合类型写法，如 `["string", "null"]`）：
 * 只要命中其中之一即通过。宿主配置里有大量"要么填值、要么留空"的键
 * （`config/default_config/*.yaml` 里以 `key:` 收尾的那些），没有联合类型就只能
 * 把它们写成 `string` 而在用户留空时报错，或者干脆不建模。
 *
 * @param {unknown} value 待判断的值
 * @param {string|string[]} type JSON Schema 的类型名（或类型数组）
 * @returns {boolean}
 */
function matchesType(value, type) {
  if (Array.isArray(type)) return type.some(item => matchesType(value, item))

  switch (type) {
    case "object":
      return isPlainObject(value)
    case "array":
      return Array.isArray(value)
    case "string":
      return typeof value === "string"
    // integer 与 number 都要求有限数值；integer 额外要求整数
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      // 未知类型名：不判定失败，交由上层的 schema 自检（checkSchema）去报告
      return true
  }
}

/**
 * 把 `type` 渲染成给人看的文案（联合类型用 ` | ` 连接）。
 *
 * @param {string|string[]} type 类型名或类型数组
 * @returns {string} 展示用文本
 */
function describeExpected(type) {
  return Array.isArray(type) ? type.join(" | ") : String(type)
}

/**
 * 把一个值渲染成"实际是什么类型"的文案（`null` 需要单独说）。
 *
 * @param {unknown} value 值
 * @returns {string} 展示用文本
 */
function describeActual(value) {
  return value === null ? "null" : typeof value
}

/**
 * 校验 schema 自身是否合法（而非校验数据）。
 *
 * 用于在加载期就把插件自带 schema 的写法错误暴露出来，而不是等到用户填了配置才发现。
 *
 * @param {unknown} schema 待检查的 schema（来自插件的 JSON，因此类型为 unknown）
 * @param {string} [path] 当前路径，仅用于报错定位
 * @returns {Array<{ path: string, message: string }>} 问题列表，空数组表示合法
 */
export function checkSchema(schema, path = "") {
  /** @type {Array<{ path: string, message: string }>} */
  const errors = []
  if (!isPlainObject(schema)) {
    errors.push({ path, message: "schema 必须是对象" })
    return errors
  }

  const type = schema.type
  if (type !== undefined) {
    // 允许联合类型数组（见 matchesType 的说明）；逐个元素检查，并挡掉空数组
    const list = Array.isArray(type) ? type : [type]
    if (!list.length) errors.push({ path: `${path}.type`, message: "type 数组不能为空" })
    for (const item of list)
      if (!SUPPORTED_TYPES.includes(String(item)))
        errors.push({
          path: `${path}.type`,
          message: `不支持的 type「${String(item)}」，可用：${SUPPORTED_TYPES.join(" / ")}`,
        })
  }

  if (schema.properties !== undefined && !isPlainObject(schema.properties))
    errors.push({ path: `${path}.properties`, message: "properties 必须是对象" })

  if (schema.items !== undefined && !isPlainObject(schema.items))
    errors.push({ path: `${path}.items`, message: "items 必须是对象" })

  if (schema.required !== undefined && !Array.isArray(schema.required))
    errors.push({ path: `${path}.required`, message: "required 必须是字符串数组" })

  if (schema.enum !== undefined && !Array.isArray(schema.enum))
    errors.push({ path: `${path}.enum`, message: "enum 必须是数组" })

  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      errors.push({ path: `${path}.pattern`, message: "pattern 必须是字符串" })
    } else {
      try {
        new RegExp(schema.pattern)
      } catch {
        errors.push({ path: `${path}.pattern`, message: `pattern 不是合法正则：${schema.pattern}` })
      }
    }
  }

  // 递归检查子树
  if (isPlainObject(schema.properties))
    for (const [key, sub] of Object.entries(schema.properties))
      errors.push(...checkSchema(sub, path ? `${path}.properties.${key}` : `properties.${key}`))
  if (isPlainObject(schema.items)) errors.push(...checkSchema(schema.items, `${path}.items`))

  return errors
}

/**
 * 按 schema 填充缺失的默认值，返回新对象（不修改入参）。
 *
 * 规则：
 * - 顶层为非对象时，若 schema 自身有 `default` 则整体替换为默认值；
 * - 缺失的键（`undefined`）填入 `default`；
 * - 已有值为 `null` 时**不**填充（`null` 是用户显式选择）；
 * - 数组元素与嵌套对象递归处理。
 *
 * @param {unknown} schema 配置 schema（来自插件的 JSON）
 * @param {unknown} value 用户值
 * @returns {unknown} 填充后的新值
 */
export function applyDefaults(schema, value) {
  if (!isPlainObject(schema)) return value

  if (value === undefined && schema.default !== undefined) return structuredClone(schema.default)

  if (schema.type === "object" || (value !== undefined && isPlainObject(value))) {
    /** @type {Record<string, unknown>} */
    const out = isPlainObject(value) ? { ...value } : {}
    if (isPlainObject(schema.properties))
      for (const [key, sub] of Object.entries(schema.properties)) {
        const filled = applyDefaults(sub, out[key])
        if (filled !== undefined) out[key] = filled
        else if (key in out && out[key] === undefined) delete out[key]
      }
    return out
  }

  if (schema.type === "array" || Array.isArray(value)) {
    if (!Array.isArray(value)) return value
    if (!isPlainObject(schema.items)) return [...value]
    return value.map(item => applyDefaults(schema.items, item))
  }

  return value
}

/**
 * 按 schema 校验值，返回问题列表（空数组表示通过）。
 *
 * 只报告第一个命中的问题/路径（不做错误去重），每条问题都带可在 UI 中定位的 `path`。
 *
 * @param {unknown} schema 配置 schema（来自插件的 JSON）
 * @param {unknown} value 待校验的值
 * @param {string} [path] 当前路径，用于报错定位
 * @returns {Array<{ path: string, message: string }>} 问题列表
 */
export function validate(schema, value, path = "") {
  /** @type {Array<{ path: string, message: string }>} */
  const errors = []
  if (!isPlainObject(schema)) return errors

  const label = path || "根配置"
  // schema 来自外部 JSON，`type` 的静态类型是 unknown；`checkSchema` 负责在加载期
  // 就把非法写法报出来，这里按受控子集的约定收窄（未知类型名 matchesType 会放行）
  const type = /** @type {string|string[]|undefined} */ (schema.type)
  const hasValidator = VALIDATING_KEYWORDS.some(key => key in schema)

  // 值为 undefined 时只检查 required（由父级负责），避免"未填"与"填错"混淆
  if (value === undefined) return errors

  if (type && !matchesType(value, type)) {
    errors.push({
      path: label,
      message: `期望 ${describeExpected(type)}，实际是 ${describeActual(value)}`,
    })
    // 类型不符时后续关键字都没有意义，直接返回
    return errors
  }

  if (!hasValidator && !type) return errors

  if (Array.isArray(schema.enum) && !schema.enum.some(item => item === value))
    errors.push({
      path: label,
      message: `必须是以下之一：${schema.enum.map(item => JSON.stringify(item)).join(" / ")}`,
    })

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push({ path: label, message: `不能小于 ${schema.minimum}` })
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push({ path: label, message: `不能大于 ${schema.maximum}` })
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push({ path: label, message: `长度不能少于 ${schema.minLength}` })
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push({ path: label, message: `长度不能超过 ${schema.maxLength}` })
    if (typeof schema.pattern === "string") {
      let reg
      try {
        reg = new RegExp(schema.pattern)
      } catch {
        // schema 自身的错误由 checkSchema 报告，这里不重复
        reg = undefined
      }
      if (reg && !reg.test(value)) errors.push({ path: label, message: `不匹配 ${schema.pattern}` })
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required))
      for (const key of schema.required)
        if (value[key] === undefined)
          errors.push({
            path: path ? `${path}.${key}` : key,
            message: "必填项缺失",
          })

    if (isPlainObject(schema.properties))
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (!(key in value)) continue
        errors.push(...validate(sub, value[key], path ? `${path}.${key}` : key))
      }
  }

  if (Array.isArray(value) && isPlainObject(schema.items))
    value.forEach((item, index) => {
      errors.push(...validate(schema.items, item, `${path}[${index}]`))
    })

  return errors
}

/**
 * 一步完成"填默认值 + 校验"，插件加载期的入口。
 *
 * @param {unknown} schema 配置 schema（来自插件的 JSON）
 * @param {unknown} value 用户配置
 * @returns {{ value: unknown, errors: Array<{ path: string, message: string }> }}
 */
export function normalize(schema, value) {
  const filled = applyDefaults(schema, value)
  return { value: filled, errors: validate(schema, filled) }
}
