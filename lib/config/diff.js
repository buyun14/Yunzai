import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

/**
 * 用户配置与出厂默认配置的差异报告（`node . config:diff`）。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.2。
 *
 * # 为什么需要它
 *
 * 配置类问题的第一手材料永远是"用户那份与出厂那份差在哪"。`initCfg()` 只负责
 * 把**缺失的文件**补上，不管文件**内部**少了哪个键、多了哪个键、哪个键被改过。
 * 于是"升级后新加的配置项我没有"、"这个键删了我这里还留着"这类问题
 * 只能靠人肉比对两份 yaml。这个模块把那件事变成一条命令。
 *
 * # 三条刻意的约束
 *
 * 1. **只读**。本模块只读文件、不写任何东西，而且**不导入 `lib/config/config.js`**
 *    ——那边的构造函数会跑 `initCfg()`，会往用户配置里复制文件。
 *    一个叫"差异报告"的命令顺手改了用户的配置，是最不该有的意外。
 * 2. **数组按整体比较**。数组在配置里表达的是"这个列表"，元素顺序也算语义的一部分
 *    （`masterQQ: [1,2]` 与 `[2,1]` 不当作相同）；逐个下标展开只会制造噪声。
 * 3. **输出有上限**。`group.yaml` 里每个群一段，差异可能是几百条；
 *    默认只列前若干条并明确写出"还有多少没列"，要全部看用 `--all`。
 */

/** 用户配置目录 */
export const CONFIG_DIR = "config/config"

/** 出厂默认配置目录 */
export const DEFAULTS_DIR = "config/default_config"

/**
 * 把嵌套配置压成 `a.b.c` → 值 的扁平表。
 *
 * 对象继续下钻；标量与数组都当作叶子（见文件头的约束 2）。
 * 空对象不产出任何条目——它在两份配置里都等价于"什么都没有"。
 *
 * @param {unknown} value 配置值
 * @param {string} [prefix] 已累积的路径前缀
 * @returns {Map<string, unknown>} 扁平表
 */
export function flattenConfig(value, prefix = "") {
  /** @type {Map<string, unknown>} */
  const flat = new Map()

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) flat.set(prefix, value)
    return flat
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key
    for (const [entryPath, entryValue] of flattenConfig(child, childPath))
      flat.set(entryPath, entryValue)
  }

  return flat
}

/**
 * 两份扁平配置的差异。
 *
 * @param {Map<string, unknown>} user 用户配置
 * @param {Map<string, unknown>} defaults 出厂默认
 * @returns {{ missing: Array<{key: string, default: unknown}>, extra: Array<{key: string, user: unknown}>, changed: Array<{key: string, user: unknown, default: unknown}> }} 差异
 */
export function diffFlattened(user, defaults) {
  /** @type {Array<{key: string, default: unknown}>} */
  const missing = []
  /** @type {Array<{key: string, user: unknown}>} */
  const extra = []
  /** @type {Array<{key: string, user: unknown, default: unknown}>} */
  const changed = []

  for (const [key, value] of defaults) {
    if (!user.has(key)) missing.push({ key, default: value })
    else if (!sameValue(user.get(key), value))
      changed.push({ key, user: user.get(key), default: value })
  }

  for (const [key, value] of user) if (!defaults.has(key)) extra.push({ key, user: value })

  return { missing, extra, changed }
}

/**
 * 逐文件收集差异。
 *
 * 只比较两个目录里都算 yaml 的文件；两个目录的文件清单取并集，
 * 于是"用户多建了一个配置文件"与"默认新增了一个配置文件而用户没有"都能被看见。
 *
 * @param {{ configDir?: string, defaultsDir?: string }} [options] 选项
 * @returns {Promise<{ files: Array<{ name: string, status: string, missing: any[], extra: any[], changed: any[] }>, summary: { files: number, missing: number, extra: number, changed: number } }>} 结果
 */
export async function collectDiff({
  configDir = CONFIG_DIR,
  defaultsDir = DEFAULTS_DIR,
} = {}) {
  const userFiles = await listYaml(configDir)
  const defaultFiles = await listYaml(defaultsDir)
  const names = [...new Set([...userFiles, ...defaultFiles])].sort()

  const files = []
  for (const name of names) {
    const hasUser = userFiles.includes(name)
    const hasDefault = defaultFiles.includes(name)
    const status = hasUser && hasDefault ? "both" : hasUser ? "only-user" : "only-default"

    const user = hasUser ? flattenConfig(await readYaml(path.join(configDir, name))) : new Map()
    const defaults = hasDefault
      ? flattenConfig(await readYaml(path.join(defaultsDir, name)))
      : new Map()

    const diff = hasUser && hasDefault ? diffFlattened(user, defaults) : { missing: [], extra: [], changed: [] }
    if (status !== "both" || diff.missing.length || diff.extra.length || diff.changed.length)
      files.push({ name, status, ...diff })
  }

  return {
    files,
    summary: {
      files: files.length,
      missing: files.reduce((total, file) => total + file.missing.length, 0),
      extra: files.reduce((total, file) => total + file.extra.length, 0),
      changed: files.reduce((total, file) => total + file.changed.length, 0),
    },
  }
}

/**
 * 把差异渲染成人看的文本。
 *
 * @param {{ files: Array<{ name: string, status: string, missing: any[], extra: any[], changed: any[] }>, summary: { files: number, missing: number, extra: number, changed: number } }} result `collectDiff()` 的结果
 * @param {{ limit?: number, configDir?: string, defaultsDir?: string }} [options] 选项
 * @returns {string} 文本
 */
export function formatDiff(result, {
  limit = 20,
  configDir = CONFIG_DIR,
  defaultsDir = DEFAULTS_DIR,
} = {}) {
  const lines = [
    `配置差异：${configDir}/  ←→  ${defaultsDir}/`,
    "（只比较 yaml；数组按整体比较；本命令只读，不会改动任何文件）",
    "",
  ]

  if (!result.files.length) {
    lines.push("没有差异。")
    return lines.join("\n")
  }

  let shown = 0
  let hidden = 0
  const detail = []

  /**
   * 记一条明细，超出上限时只计数。
   *
   * @param {string} line 明细行
   * @returns {void}
   */
  function push(line) {
    if (shown < limit) {
      detail.push(line)
      shown++
    } else hidden++
  }

  for (const file of result.files) {
    detail.push(`· ${file.name}`)
    if (file.status === "only-user") detail.push("    只存在于用户配置（默认里已没有这个文件）")
    if (file.status === "only-default")
      detail.push("    只存在于出厂默认（你的配置里还没有这个文件）")

    for (const item of file.missing)
      push(`    待补（默认有、你没有）: ${item.key} = ${show(item.default)}`)
    for (const item of file.extra)
      push(`    多余（你有、默认没有）: ${item.key} = ${show(item.user)}`)
    for (const item of file.changed)
      push(`    不同: ${item.key} —— 你: ${show(item.user)} / 默认: ${show(item.default)}`)
  }

  lines.push(...detail)
  if (hidden) lines.push("", `……另有 ${hidden} 条未列出（加 --all 全部展开）`)

  lines.push(
    "",
    `共 ${result.summary.files} 个文件有差异：待补 ${result.summary.missing} 项、多余 ${result.summary.extra} 项、不同 ${result.summary.changed} 项。`,
  )

  return lines.join("\n")
}

/**
 * 列出一个目录里的 yaml 文件名。
 *
 * @param {string} dir 目录
 * @returns {Promise<string[]>} 文件名（目录不存在时为空数组）
 */
async function listYaml(dir) {
  try {
    const names = await fs.readdir(dir)
    return names.filter(name => name.endsWith(".yaml") || name.endsWith(".yml"))
  } catch {
    return []
  }
}

/**
 * 读并解析一个 yaml 文件；读不到或解析不出对象时返回空对象。
 *
 * 解析失败**不抛错**：差异报告的价值在于"能看完"，一个坏文件不该让整条命令中断。
 *
 * @param {string} file 文件路径
 * @returns {Promise<Record<string, unknown>>} 配置对象
 */
async function readYaml(file) {
  try {
    const parsed = YAML.parse(await fs.readFile(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 两个配置值是否相同。
 *
 * 叶子只可能是标量或数组，`JSON.stringify` 足够：数组的顺序差异会被如实判为不同
 * （要的就是这个）。
 *
 * @param {unknown} a 值
 * @param {unknown} b 值
 * @returns {boolean} 是否相同
 */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 把值渲染成一行短文本。
 *
 * @param {unknown} value 值
 * @returns {string} 短文本（长值会被截断）
 */
function show(value) {
  const text = JSON.stringify(value)
  if (text === undefined) return "undefined"
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}
