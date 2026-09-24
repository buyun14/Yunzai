import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { BACKUP_ROOT, createBackup, DEFAULT_CONFIG_DIR } from "./backup.js"
import { CURRENT_CONFIG_VERSION, readVersion, writeVersion } from "./version.js"

/**
 * 配置迁移的执行器：按版本号顺序跑那些"还没跑过"的迁移脚本。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.1。
 *
 * # 三条硬约束
 *
 * 1. **迁移前强制备份**。迁移脚本会改用户的配置文件，而配置文件是用户唯一
 *    没有版本控制的东西。备份不是可选项。
 * 2. **失败即中止启动**。半迁移状态（脚本跑到一半、`_meta.json` 没更新）比
 *    不迁移危险得多：下一次启动会重跑一遍，而重跑的前提是幂等——
 *    "失败"恰恰意味着幂等的前提不成立。所以这里只抛错，由调用方中止进程。
 * 3. **错误信息必须能照着做**。光说"迁移失败"没用，用户需要知道备份在哪、
 *    怎么退回去。`ConfigMigrationError` 的消息里两样都写了。
 *
 * # 脚本形态
 *
 * 每个脚本 `export default { version, description, up(configDir) }`，
 * 文件名只是给人看的排序线索，真正的顺序由 `version` 决定。
 * **`up()` 必须幂等**：重复执行不能有额外副作用（用户可能从旧备份恢复回来，
 * 于是同一条迁移会再跑一次）。
 */

/** 迁移脚本目录 */
export const MIGRATIONS_DIR = "lib/config/migrations"

/** 迁移失败。消息里带备份路径与恢复命令，调用方直接打印即可 */
export class ConfigMigrationError extends Error {
  /**
   * @param {string} message 人话
   * @param {{ backup?: string, cause?: unknown }} [options] 附加信息
   */
  constructor(message, { backup, cause } = {}) {
    super(message, { cause })
    this.name = "ConfigMigrationError"
    this.backup = backup
  }
}

/**
 * 载入全部迁移脚本，按版本号升序返回。
 *
 * @param {string} [dir] 脚本目录
 * @returns {Promise<Array<{ version: number, description?: string, up: (configDir: string) => Promise<void>, file: string }>>} 迁移列表
 */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = (await fs.readdir(dir)).filter(file => file.endsWith(".js")).sort()
  const migrations = []

  for (const file of files) {
    const module = await import(pathToFileURL(path.resolve(dir, file)).href)
    const migration = module.default

    if (typeof migration?.up !== "function" || !Number.isInteger(migration.version))
      throw new ConfigMigrationError(
        `迁移脚本 ${file} 的形状不对：需要 export default { version: 整数, up(configDir) }`,
      )

    if (migration.version > CURRENT_CONFIG_VERSION)
      throw new ConfigMigrationError(
        `迁移脚本 ${file} 的版本号（${migration.version}）大于 CURRENT_CONFIG_VERSION（${CURRENT_CONFIG_VERSION}），` +
          "忘了同步 lib/config/version.js？",
      )

    migrations.push({ ...migration, file })
  }

  const sorted = migrations.sort((a, b) => a.version - b.version)

  // 版本号必须唯一：两条同号迁移的执行顺序就成了文件名顺序，那是运气不是设计
  for (let index = 1; index < sorted.length; index++)
    if (sorted[index].version === sorted[index - 1].version)
      throw new ConfigMigrationError(
        `迁移版本号 ${sorted[index].version} 重复：${sorted[index - 1].file} 与 ${sorted[index].file}`,
      )

  return sorted
}

/**
 * 跑完所有缺失的迁移。
 *
 * 已是最新时**什么都不做**（不备份、不写文件），因此可以放心地在每次启动时调用。
 *
 * @param {{ configDir?: string, migrationsDir?: string, backupRoot?: string, now?: Date }} [options] 选项
 * @returns {Promise<{ from: number, to: number, applied: string[], backup?: string }>} 执行结果
 */
export async function runMigrations({
  configDir = DEFAULT_CONFIG_DIR,
  migrationsDir = MIGRATIONS_DIR,
  backupRoot = BACKUP_ROOT,
  now = new Date(),
} = {}) {
  const from = await readVersion(configDir)
  const migrations = await loadMigrations(migrationsDir)

  const pending = migrations.filter(migration => migration.version > from)
  if (!pending.length) return { from, to: from, applied: [] }

  const backup = await createBackup({
    configDir,
    root: backupRoot,
    now,
    reason: `升级配置 v${from} → v${CURRENT_CONFIG_VERSION}`,
  })

  const applied = []
  for (const migration of pending) {
    try {
      await migration.up(configDir)
      applied.push(`${migration.file}（${migration.description ?? "无描述"}）`)
    } catch (err) {
      throw new ConfigMigrationError(
        [
          `配置迁移失败：${migration.file}（v${migration.version}）。`,
          `已经执行成功的迁移：${applied.length ? applied.join("、") : "无"}。`,
          "正在中止启动——半迁移状态继续跑会比不迁移更危险。",
          "",
          "恢复方式（二选一）：",
          `  1. 把备份覆盖回去：${backup}/config/  →  ${configDir}/`,
          `  2. 执行：node . restore ${backup}`,
          "",
          `原始错误：${err instanceof Error ? err.message : String(err)}`,
        ].join("\n"),
        { backup, cause: err },
      )
    }
  }

  // 版本号只在**全部成功之后**才写：中途失败时版本停在旧值，
  // 下次启动会重跑整条链——这正是要求每个 up() 幂等的原因。
  await writeVersion(CURRENT_CONFIG_VERSION, { configDir, extra: { migrated_from: from } })

  return { from, to: CURRENT_CONFIG_VERSION, applied, backup }
}
