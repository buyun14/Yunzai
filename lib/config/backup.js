import fs from "node:fs/promises"
import path from "node:path"

/**
 * 配置目录的备份与恢复。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.1 与 §3.4。
 *
 * 本模块只做**目录级**的整份快照（迁移前自动备份、恢复时先存当前状态）。
 * 版本化的 ZIP 逻辑包（`node . backup` / `node . restore`）是 §3.4 的事，
 * 它需要 manifest、排除 `temp/`、跨版本迁移等，与这里的"保险绳"职责不同，
 * 所以刻意分开：这里失败必须极简单、可读、可手工复原。
 *
 * # 备份放哪
 *
 * `config/backups/<时间戳>/config/` —— 位于 `config/` 下（该目录整个被 gitignore），
 * 与被备份的 `config/config/` 是**不同子树**，所以不会递归拷到自己。
 */

/** 备份根目录 */
export const BACKUP_ROOT = "config/backups"

/** 默认的被备份目录 */
export const DEFAULT_CONFIG_DIR = "config/config"

/**
 * 生成时间戳目录名：`20260924-104933`。
 *
 * 用本地时间而不是 ISO 字符串，是为了让 `ls` 出来的顺序等于时间顺序，
 * 且名字里不带 Windows 不允许的冒号。
 *
 * @param {Date} [now] 时间
 * @returns {string} 目录名
 */
export function stampOf(now = new Date()) {
  const pad = value => String(value).padStart(2, "0")
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * 备份一份配置目录。
 *
 * 时间戳相同时（同一秒内连续备份）自动加后缀，**不覆盖已有的备份**——
 * 备份被覆盖掉是这类工具最不该犯的错。
 *
 * @param {{ configDir?: string, root?: string, now?: Date, reason?: string }} [options] 选项
 * @returns {Promise<string>} 备份目录路径
 */
export async function createBackup({
  configDir = DEFAULT_CONFIG_DIR,
  root = BACKUP_ROOT,
  now = new Date(),
  reason = "",
} = {}) {
  await fs.mkdir(root, { recursive: true })

  const base = stampOf(now)
  let name = base
  for (let index = 1; await exists(path.join(root, name)); index++) name = `${base}-${index}`

  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.cp(configDir, path.join(dir, "config"), { recursive: true })

  const note = [
    `备份时间：${now.toISOString()}`,
    `来源目录：${configDir}`,
    reason ? `原因：${reason}` : "原因：（未说明）",
    "",
    "恢复方式：把本目录下的 config/ 覆盖回来源目录，或执行",
    `  node . restore ${dir}`,
  ].join("\n")
  await fs.writeFile(path.join(dir, "README.txt"), `${note}\n`)

  return dir
}

/**
 * 列出全部备份，按名字（即时间）倒序——最新的在前。
 *
 * @param {{ root?: string }} [options] 选项
 * @returns {Promise<Array<{ name: string, dir: string, hasConfig: boolean }>>} 备份列表
 */
export async function listBackups({ root = BACKUP_ROOT } = {}) {
  let names
  try {
    names = await fs.readdir(root)
  } catch {
    return [] // 还没有任何备份
  }

  const result = []
  for (const name of names.sort().reverse())
    result.push({
      name,
      dir: `${root}/${name}`,
      hasConfig: await exists(path.join(root, name, "config")),
    })

  return result
}

/**
 * 恢复一份备份。
 *
 * **先备份当前状态再覆盖**：恢复本身也可能是一次误操作，如果不先留一份，
 * 用户就没有第二次机会了。返回值里带上这次"恢复前"的备份路径。
 *
 * @param {string} name 备份目录名（`listBackups()` 的 `name`）
 * @param {{ configDir?: string, root?: string, now?: Date }} [options] 选项
 * @returns {Promise<{ restored: string, previous: string }>} 恢复结果
 */
export async function restoreBackup(name, {
  configDir = DEFAULT_CONFIG_DIR,
  root = BACKUP_ROOT,
  now = new Date(),
} = {}) {
  const source = path.join(root, name, "config")
  if (!(await exists(source)))
    throw new Error(`备份 ${name} 里没有 config/ 目录，无法恢复（确认一下 ${root} 下的目录名）`)

  const previous = await createBackup({ configDir, root, now, reason: `恢复 ${name} 之前的现场` })

  await fs.rm(configDir, { recursive: true, force: true })
  await fs.cp(source, configDir, { recursive: true })

  return { restored: name, previous }
}

/**
 * 路径是否存在。
 *
 * @param {string} target 路径
 * @returns {Promise<boolean>} 是否存在
 */
async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}
