import fs from "node:fs/promises"
import path from "node:path"
import { normalize } from "./schema.js"

/**
 * 插件配置的读取、校验与首次落盘。
 *
 * 对应文档：docs/refactor/01-plugin-contract.md §3.2 / §5.3
 *
 * ## 行为边界（阶段 1 刻意保持极窄）
 *
 * - **只读注入**：把校验后的配置对象挂到插件的 `contract.config` 上；
 * - **不接管读取路径**：旧插件继续用 `cfg.getGroup()` / `lib/plugins/config.js` 的
 *   `makeConfig()` / 自己读 yaml，行为完全不变；
 * - **不静默改写用户数据**：校验不通过只告警，不会把用户填的值改成默认值。
 *   缺失的键才由 schema 的 `default` 填充。
 */

/** 用户配置目录（`config/` 整体被 .gitignore 覆盖） */
const CONFIG_DIR = path.join("config", "plugin")

/**
 * 某个插件目录对应的用户配置文件路径。
 *
 * @param {string} dirName 插件目录名
 * @returns {string}
 */
export function configFileFor(dirName) {
  return path.join(CONFIG_DIR, `${dirName}.json`)
}

/**
 * 读取并校验一个插件目录的配置。
 *
 * @param {string} dirName 插件目录名
 * @param {import("./metadata.js").PluginMetadata} metadata 插件元数据
 * @returns {Promise<{
 *   config: Record<string, unknown>,
 *   configFile: string|null,
 *   created: boolean,
 *   problems: string[],
 *   fatal: boolean,
 * }>}
 */
export async function loadPluginConfig(dirName, metadata) {
  /** @type {{ config: Record<string, unknown>, configFile: string|null, created: boolean, problems: string[], fatal: boolean }} */
  const result = { config: {}, configFile: null, created: false, problems: [], fatal: false }

  // 插件未声明配置：不做任何事，保持与改造前完全一致
  if (!metadata?.config) return result

  const dir = path.join("plugins", dirName)
  result.configFile = configFileFor(dirName)

  // 未声明 defaults 时不能把空串交给 path.join——join(dir, "") 会得到目录本身，
  // 随后读取会以 EISDIR 失败
  const defaults = metadata.config.defaults
    ? await readJson(path.join(dir, metadata.config.defaults), result, "配置默认值")
    : null
  const declared = await readJson(result.configFile, result, "用户配置")

  // 浅合并即可：嵌套的缺失键由 applyDefaults 递归补齐，
  // 而数组与显式 null 都应当整体采用用户值
  const merged = { ...(defaults ?? {}), ...(declared ?? {}) }

  const schema = await readJson(path.join(dir, metadata.config.schema), result, "配置 schema")

  if (schema) {
    const { value, errors } = normalize(schema, merged)
    result.config = /** @type {Record<string, unknown>} */ (value ?? {})
    for (const item of errors) result.problems.push(`配置校验失败 → ${item.path}：${item.message}`)
  } else {
    result.config = merged
  }

  // 用户配置文件不存在时写出一份，让用户能看到全部可用键
  if (declared === null) {
    try {
      await fs.mkdir(CONFIG_DIR, { recursive: true })
      await fs.writeFile(result.configFile, `${JSON.stringify(result.config, null, 2)}\n`, "utf8")
      result.created = true
    } catch (err) {
      result.problems.push(`写出配置文件 ${result.configFile} 失败：${err.message}`)
    }
  }

  return result
}

/**
 * 读取 JSON 文件，把问题收集到 `result.problems` 并返回 `null` 表示不可用。
 *
 * @param {string} file 文件路径
 * @param {{ problems: string[] }} result 用于收集问题的对象
 * @param {string} label 该文件的用途，用于报错文案
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function readJson(file, result, label) {
  if (!file) return null
  let text
  try {
    text = await fs.readFile(file, "utf8")
  } catch (err) {
    // 未声明 / 尚未创建属于正常情况，不产生任何输出
    if (err?.code !== "ENOENT") result.problems.push(`读取${label} ${file} 失败：${err.message}`)
    return null
  }

  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      result.problems.push(`${label} ${file} 的顶层必须是对象`)
      return null
    }
    return parsed
  } catch (err) {
    result.problems.push(`${label} ${file} 不是合法 JSON：${err.message}`)
    return null
  }
}
