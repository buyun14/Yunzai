import fs from "node:fs/promises"
import path from "node:path"
import { checkSchema } from "./schema.js"

/**
 * 插件元数据：读取、校验、缓存与"旧插件合成"。
 *
 * 对应文档：docs/refactor/01-plugin-contract.md §3.1
 *
 * ## 粒度是「插件目录」而不是「插件文件」
 *
 * Yunzai 的一个插件目录就是一个可分发的包（一个 git 仓库），例如 `plugins/system/`
 * 下有 9 个 `.js`，它们是同一个包的 9 个插件类。因此元数据放在目录级：
 *
 * ```
 * plugins/<目录名>/plugin.json
 * ```
 *
 * 每个插件类自己的 `name` / `priority` / `namespace` 仍然由类决定，不受元数据影响，
 * 因此本次改造**不改变**任何现有插件的展示名与优先级。
 *
 * ## 校验失败的处置策略
 *
 * | 情况 | 处置 | 理由 |
 * |---|---|---|
 * | `plugin.json` 不存在 | 合成"旧插件"元数据 | 必须兼容存量插件 |
 * | JSON 语法错误 / 顶层不是对象 | 告警 + 退回合成 | 一个可选文件不应该让本来能用的插件失效 |
 * | 已知字段类型不对 | 告警 + 该字段用默认值 | 同上，逐字段降级 |
 * | 未知字段 | 静默忽略 | 向前兼容 |
 * | `yunzai` 范围不满足 | **拒绝加载**（由 loader 决定） | 这是本机制存在的核心目的 |
 */

/** 元数据文件名 */
export const METADATA_FILENAME = "plugin.json"

/** 默认的配置 schema 文件名（当 `config` 为 `true` 或对象但未指定时） */
export const DEFAULT_SCHEMA_FILENAME = "config.schema.json"

/** 字符串字段及其默认值 */
const STRING_FIELDS = /** @type {const} */ ({
  name: "",
  // version 缺省为空串（未知）而不是 0.0.0：
  // - 核心自带的插件包跟随宿主版本，写死会造成与 package.json 的版本漂移；
  // - 第三方插件未声明版本时，“未知”比伪造一个 0.0.0 更诚实。
  version: "",
  description: "",
  author: "",
  repo: "",
  yunzai: "",
})

const ARRAY_FIELDS = /** @type {const} */ (["platforms", "capabilities"])

/**
 * @typedef {object} PluginMetadata
 * @property {string} name 插件包名，缺省时回落到目录名
 * @property {string} version 版本，缺省为空串（未知）
 * @property {string} description 简介
 * @property {string} author 作者
 * @property {string} repo 仓库地址
 * @property {string} yunzai 宿主版本要求（semver range），空表示不限制
 * @property {string[]} platforms 支持的适配器 id，`["*"]` 表示全部
 * @property {string[]} capabilities 声明的能力，供展示与校验
 * @property {{ schema: string, defaults: string|null }|null} config 配置 schema 声明
 * @property {Record<string, Record<string, unknown>>} i18n 按 locale 分组的文案
 * @property {"declared"|"legacy"} source 元数据来源
 */

/**
 * 从插件 key 取出所属目录名。
 *
 * `getPlugins()` 产生的 key 有两种形态：`<目录>`（目录内有 index.js）
 * 与 `<目录>/<文件>.js`（目录内是散装插件文件）。
 *
 * @param {string} key 插件 key
 * @returns {string} 目录名
 */
export function dirNameFromKey(key) {
  return String(key).split("/")[0]
}

/**
 * 校验并归一化原始元数据对象。
 *
 * @param {unknown} raw 从 `plugin.json` 解析出的对象
 * @param {string} dirName 插件目录名，用作 name 的兜底
 * @returns {{ metadata: PluginMetadata, errors: string[], warnings: string[] }}
 */
export function validateMetadata(raw, dirName) {
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("plugin.json 的顶层必须是对象")
    return { metadata: legacyMetadata(dirName), errors, warnings }
  }

  const source = /** @type {Record<string, unknown>} */ (raw)
  /** @type {PluginMetadata} */
  const metadata = legacyMetadata(dirName)
  metadata.source = "declared"

  for (const field of Object.keys(STRING_FIELDS)) {
    const value = source[field]
    if (value === undefined) continue
    if (typeof value !== "string") {
      warnings.push(`字段 ${field} 期望字符串，实际是 ${typeof value}，已忽略`)
      continue
    }
    metadata[/** @type {keyof typeof STRING_FIELDS} */ (field)] = value
  }

  for (const field of ARRAY_FIELDS) {
    const value = source[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
      warnings.push(`字段 ${field} 期望字符串数组，已忽略`)
      continue
    }
    metadata[field] = [...value]
  }

  if (source.i18n !== undefined) {
    if (source.i18n === null || typeof source.i18n !== "object" || Array.isArray(source.i18n))
      warnings.push("字段 i18n 期望对象，已忽略")
    else metadata.i18n = /** @type {Record<string, Record<string, unknown>>} */ (source.i18n)
  }

  if (source.config !== undefined && source.config !== null) {
    if (source.config === true) {
      metadata.config = { schema: DEFAULT_SCHEMA_FILENAME, defaults: null }
    } else if (typeof source.config === "object" && !Array.isArray(source.config)) {
      const config = /** @type {Record<string, unknown>} */ (source.config)
      const schema = typeof config.schema === "string" ? config.schema : DEFAULT_SCHEMA_FILENAME
      const defaults = typeof config.defaults === "string" ? config.defaults : null
      metadata.config = { schema, defaults }
    } else {
      warnings.push("字段 config 期望 true 或对象，已忽略")
    }
  }

  if (!metadata.name) metadata.name = dirName
  if (metadata.platforms.length === 0) metadata.platforms = ["*"]

  return { metadata, errors, warnings }
}

/**
 * 为没有 `plugin.json` 的插件合成元数据。
 *
 * 合成结果必须与"作者手写一份等价 plugin.json"的行为一致，`tests/unit/plugins/metadata.test.js`
 * 对此有断言。
 *
 * @param {string} dirName 插件目录名
 * @returns {PluginMetadata}
 */
export function legacyMetadata(dirName) {
  return {
    name: dirName,
    version: "",
    description: "",
    author: "",
    repo: "",
    yunzai: "",
    platforms: ["*"],
    capabilities: [],
    config: null,
    i18n: {},
    source: "legacy",
  }
}

/** @type {Map<string, Promise<{ metadata: PluginMetadata, exists: boolean, errors: string[], warnings: string[] }>>} */
const cache = new Map()

/**
 * 读取某个插件目录的元数据（带缓存）。
 *
 * 同一目录下的多个插件文件会并发请求同一次读取，因此缓存里存的是 **Promise** 而非结果，
 * 以免并发时重复读盘。
 *
 * @param {string} dirName 插件目录名
 * @param {{ refresh?: boolean }} [opts] `refresh` 为真时忽略缓存（热更新用）
 * @returns {Promise<{ metadata: PluginMetadata, exists: boolean, errors: string[], warnings: string[] }>}
 */
export function readMetadata(dirName, opts = {}) {
  if (opts.refresh) cache.delete(dirName)
  const hit = cache.get(dirName)
  if (hit) return hit

  const task = loadMetadata(dirName)
  cache.set(dirName, task)
  return task
}

/**
 * 清空元数据缓存。
 *
 * @param {string} [dirName] 只清某个目录；缺省清空全部
 */
export function clearMetadataCache(dirName) {
  if (dirName === undefined) cache.clear()
  else cache.delete(dirName)
}

/**
 * 实际的读盘与校验逻辑。
 *
 * @param {string} dirName 插件目录名
 * @returns {Promise<{ metadata: PluginMetadata, exists: boolean, errors: string[], warnings: string[] }>}
 */
async function loadMetadata(dirName) {
  const file = path.join("plugins", dirName, METADATA_FILENAME)

  let text
  try {
    text = await fs.readFile(file, "utf8")
  } catch (err) {
    // 文件不存在是最常见的情况（存量插件），静默走合成路径
    if (err?.code !== "ENOENT") globalThis.logger?.debug?.(`读取 ${file} 失败`, err)
    return { metadata: legacyMetadata(dirName), exists: false, errors: [], warnings: [] }
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      metadata: legacyMetadata(dirName),
      exists: true,
      errors: [],
      warnings: [`${file} 不是合法 JSON（${err.message}），已按无元数据处理`],
    }
  }

  const result = validateMetadata(raw, dirName)
  return { ...result, exists: true }
}

/**
 * 校验插件声明的配置 schema 自身是否合法。
 *
 * 在加载期就把 schema 的写法错误报出来，而不是等用户填了配置才发现。
 *
 * @param {unknown} schema 解析后的 schema 对象
 * @returns {string[]} 问题列表
 */
export function checkConfigSchema(schema) {
  return checkSchema(schema).map(item =>
    item.path ? `${item.path}: ${item.message}` : item.message,
  )
}
