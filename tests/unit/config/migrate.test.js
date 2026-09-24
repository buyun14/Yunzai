import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import YAML from "yaml"
import { createBackup, listBackups, restoreBackup } from "../../../lib/config/backup.js"
import { ConfigMigrationError, loadMigrations, runMigrations } from "../../../lib/config/migrate.js"
import {
  CURRENT_CONFIG_VERSION,
  readVersion,
  writeVersion,
} from "../../../lib/config/version.js"

/**
 * 配置版本化与幂等迁移（阶段 5 §3.1）。
 *
 * 对应的验收项（`05-persistence-config.md` §6）：首次启动生成 `_meta.json`、
 * 迁移幂等（第二次不产生文件变更）、迁移前自动备份且可列出可恢复、
 * 迁移失败时中止并给出具体恢复命令。
 *
 * 全部在临时目录里跑：**绝不碰真实的 `config/config/`**，那里是用户配置。
 */

let root
/** 被迁移的用户配置目录 */
let configDir
/** 备份根目录 */
let backupRoot
/** 迁移脚本目录 */
let migrationsDir

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-migrate-"))
  configDir = path.join(root, "config", "config")
  backupRoot = path.join(root, "config", "backups")
  migrationsDir = path.join(root, "migrations")

  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(migrationsDir, { recursive: true })
  await fs.writeFile(path.join(configDir, "other.yaml"), "masterQQ: 12345\n")
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** 统一的选项：全部指到临时目录 */
function options(extra = {}) {
  return { configDir, migrationsDir, backupRoot, ...extra }
}

/**
 * 往临时迁移目录里放一个脚本。
 *
 * @param {string} file 文件名
 * @param {string} body 模块源码
 * @returns {Promise<void>}
 */
async function writeMigration(file, body) {
  await fs.writeFile(path.join(migrationsDir, file), body)
}

/** 一条最小可用、幂等的迁移 */
function passthrough(version, extra = "") {
  return `export default {
  version: ${version},
  description: "测试迁移 v${version}",
  async up() { ${extra} },
}
`
}

describe("version.js", () => {
  it("_meta.json 不存在时版本号读作 0", async () => {
    expect(await readVersion(configDir)).toBe(0)
  })

  it("写进去再读出来是同一个数，且带上 updated_at", async () => {
    const meta = await writeVersion(7, { configDir })
    expect(meta.config_version).toBe(7)
    expect(typeof meta.updated_at).toBe("string")
    expect(await readVersion(configDir)).toBe(7)
  })

  it("extra 字段会被保留，但覆盖不了 config_version", async () => {
    await writeVersion(3, { configDir, extra: { config_version: 999, note: "hi" } })
    expect(await readVersion(configDir)).toBe(3)
    const raw = JSON.parse(await fs.readFile(path.join(configDir, "_meta.json"), "utf8"))
    expect(raw.note).toBe("hi")
  })

  it("内容不是合法 JSON、或版本号不是非负整数时，一律读作 0", async () => {
    for (const body of ["{oops", '{"config_version": -1}', '{"config_version": "x"}', "null"]) {
      await fs.writeFile(path.join(configDir, "_meta.json"), body)
      expect(await readVersion(configDir)).toBe(0)
    }
  })
})

describe("loadMigrations", () => {
  it("真实脚本目录能载入，且版本升序、不超过当前版本", async () => {
    const migrations = await loadMigrations()
    expect(migrations.length).toBeGreaterThanOrEqual(1)
    expect(migrations[0].version).toBe(1)
    for (const migration of migrations)
      expect(migration.version).toBeLessThanOrEqual(CURRENT_CONFIG_VERSION)
  })

  it("形状不对的脚本会报错，而不是被默默跳过", async () => {
    await writeMigration("001-bad.js", "export default { version: 1 }\n")
    await expect(loadMigrations(migrationsDir)).rejects.toThrow(ConfigMigrationError)
  })

  it("版本号大于当前版本的脚本会报错（提示忘了同步 version.js）", async () => {
    await writeMigration("001-ahead.js", passthrough(CURRENT_CONFIG_VERSION + 1))
    await expect(loadMigrations(migrationsDir)).rejects.toThrow(/CURRENT_CONFIG_VERSION/)
  })

  it("版本号重复会报错", async () => {
    await writeMigration("001-a.js", passthrough(1))
    await writeMigration("002-b.js", passthrough(1))
    await expect(loadMigrations(migrationsDir)).rejects.toThrow(/重复/)
  })
})

describe("runMigrations：正常路径", () => {
  it("首次执行跑完全部迁移，并写下当前版本", async () => {
    // 想验证「一次跑多条」得先新增迁移脚本：临时目录里放几条就只跑几条，
    // 而版本号超过 `CURRENT_CONFIG_VERSION` 的脚本会被 `loadMigrations` 拦住。
    await writeMigration("001-base.js", passthrough(1))

    const result = await runMigrations(options())

    expect(result.from).toBe(0)
    expect(result.to).toBe(CURRENT_CONFIG_VERSION)
    expect(result.applied).toHaveLength(1)
    expect(await readVersion(configDir)).toBe(CURRENT_CONFIG_VERSION)
  })

  it("迁移前一定留下备份，且备份里有迁移之前的配置", async () => {
    await writeMigration("001-base.js", passthrough(1))
    const result = await runMigrations(options())

    expect(result.backup).toBeTruthy()
    const copied = await fs.readFile(path.join(result.backup, "config", "other.yaml"), "utf8")
    expect(copied).toBe("masterQQ: 12345\n")
    expect(await fs.readFile(path.join(result.backup, "README.txt"), "utf8")).toContain("恢复方式")
  })

  it("已是最新时什么都不做：不备份、不写文件", async () => {
    await writeMigration("001-base.js", passthrough(1))
    await runMigrations(options())
    const first = await fs.readFile(path.join(configDir, "_meta.json"), "utf8")
    const backupsBefore = await listBackups({ root: backupRoot })

    const second = await runMigrations(options())

    expect(second.applied).toEqual([])
    expect(second.backup).toBeUndefined()
    expect(await listBackups({ root: backupRoot })).toHaveLength(backupsBefore.length)
    expect(await fs.readFile(path.join(configDir, "_meta.json"), "utf8")).toBe(first)
  })

  it("幂等：同一条迁移跑两遍，结果一致且第二次不改动文件", async () => {
    // 手工模拟"从旧备份恢复回去"——版本号退回 0，迁移会再跑一遍
    await writeMigration("001-touch.js", passthrough(1))
    await runMigrations(options())
    const after = await fs.readFile(path.join(configDir, "other.yaml"), "utf8")

    await writeVersion(0, { configDir })
    await runMigrations(options())

    expect(await fs.readFile(path.join(configDir, "other.yaml"), "utf8")).toBe(after)
    expect(await readVersion(configDir)).toBe(CURRENT_CONFIG_VERSION)
  })

  it("版本号已经到底时一条都不跑，也不留备份", async () => {
    // 这里能钉住的是「没有缺失项时不动任何东西」，跨版本跳过则由幂等用例间接覆盖。
    await writeVersion(CURRENT_CONFIG_VERSION, { configDir })
    await writeMigration("001-base.js", passthrough(1))

    const result = await runMigrations(options())

    expect(result.applied).toEqual([])
    expect(result.backup).toBeUndefined()
    expect(result.from).toBe(CURRENT_CONFIG_VERSION)
  })
})

describe("runMigrations：失败即中止", () => {
  it("迁移抛错时：报错含备份路径与恢复命令，版本号不写、配置不改", async () => {
    await writeMigration("001-boom.js", passthrough(1, 'throw new Error("炸了")'))

    const error = await runMigrations(options()).catch(err => err)

    expect(error).toBeInstanceOf(ConfigMigrationError)
    expect(error.message).toContain("配置迁移失败")
    expect(error.message).toContain("恢复方式")
    expect(error.message).toContain(`node . restore ${error.backup}`)
    expect(error.backup).toBeTruthy()

    // 版本号停在旧值：下次启动会重跑整条链（所以 up() 必须幂等）
    expect(await readVersion(configDir)).toBe(0)
    expect(await fs.readFile(path.join(configDir, "other.yaml"), "utf8")).toBe("masterQQ: 12345\n")
  })
})

describe("backup.js", () => {
  it("同一秒内连续备份不会互相覆盖", async () => {
    const now = new Date("2026-09-24T10:49:33")
    const first = await createBackup({ configDir, root: backupRoot, now })
    const second = await createBackup({ configDir, root: backupRoot, now })

    expect(first).not.toBe(second)
    expect(path.basename(first)).toBe("20260924-104933")
    expect(path.basename(second)).toBe("20260924-104933-1")
  })

  it("列出备份：最新在前；没有备份时是空数组", async () => {
    expect(await listBackups({ root: backupRoot })).toEqual([])

    await createBackup({ configDir, root: backupRoot, now: new Date("2026-09-24T10:00:00") })
    await createBackup({ configDir, root: backupRoot, now: new Date("2026-09-24T11:00:00") })

    const list = await listBackups({ root: backupRoot })
    expect(list.map(item => item.name)).toEqual(["20260924-110000", "20260924-100000"])
    expect(list[0].hasConfig).toBe(true)
  })

  it("恢复：内容回到备份时的样子，并留下「恢复之前」的现场", async () => {
    const backup = await createBackup({ configDir, root: backupRoot })
    await fs.writeFile(path.join(configDir, "other.yaml"), "被改坏了\n")

    const result = await restoreBackup(path.basename(backup), { configDir, root: backupRoot })

    expect(await fs.readFile(path.join(configDir, "other.yaml"), "utf8")).toBe("masterQQ: 12345\n")
    // 恢复本身也可能误操作，所以恢复前的状态也要留一份
    expect(await fs.readFile(path.join(result.previous, "config", "other.yaml"), "utf8")).toBe(
      "被改坏了\n",
    )
    expect(result.restored).toBe(path.basename(backup))
  })

  it("备份名不存在时报错，且提示去看备份根目录", async () => {
    await expect(restoreBackup("不存在", { configDir, root: backupRoot })).rejects.toThrow(
      /没有 config\/ 目录/,
    )
  })
})

describe("迁移 002：masterQQ 数组化（历史快照）", () => {
  /** 仓库里真实的迁移脚本目录 */
  const REAL_MIGRATIONS = "lib/config/migrations"

  /**
   * 读一份历史快照。
   *
   * @param {"v1"|"v2"} version 快照所属的版本目录
   * @returns {Promise<string>} 文件内容
   */
  function snapshot(version) {
    return fs.readFile(new URL(`../../fixtures/config/${version}/other.yaml`, import.meta.url), "utf8")
  }

  it("把标量变成数组，且注释与未知键都还在", async () => {
    await fs.writeFile(path.join(configDir, "other.yaml"), await snapshot("v1"))

    // 用**真实**的迁移目录跑，这样测的是真的会执行的那条脚本
    await runMigrations({ ...options(), migrationsDir: REAL_MIGRATIONS })

    const after = await fs.readFile(path.join(configDir, "other.yaml"), "utf8")
    const parsed = YAML.parse(after)

    expect(parsed.masterQQ).toEqual([12345])
    expect(parsed.whiteGroup).toEqual([])
    expect(parsed._自定义).toEqual({ note: "别动我" })
    // 注释必须活下来——这就是用 parseDocument 而不是 parse + stringify 的全部意义
    expect(after).toContain("# 保留原样的注释")
    // 与期望快照语义一致（YAML 重新序列化时引号/空格会变，所以比语义不比字节）
    expect(parsed).toEqual(YAML.parse(await snapshot("v2")))
    expect(await readVersion(configDir)).toBe(CURRENT_CONFIG_VERSION)
  })

  it("幂等：已经是数组时一字不改", async () => {
    const before = await snapshot("v2")
    await fs.writeFile(path.join(configDir, "other.yaml"), before)
    // 版本停在 1，于是只有 002 会跑
    await writeVersion(CURRENT_CONFIG_VERSION - 1, { configDir })

    await runMigrations({ ...options(), migrationsDir: REAL_MIGRATIONS })

    expect(await fs.readFile(path.join(configDir, "other.yaml"), "utf8")).toBe(before)
  })

  it("没有 other.yaml 时直接返回，不抛错", async () => {
    // beforeEach 会建一份 other.yaml，所以这里要先删掉——迁移脚本对"文件不存在"
    // 必须静默放过（initCfg() 会在启动时补上它），否则老用户的启动会被卡住
    await fs.rm(path.join(configDir, "other.yaml"))
    await runMigrations({ ...options(), migrationsDir: REAL_MIGRATIONS })
    await expect(fs.access(path.join(configDir, "other.yaml"))).rejects.toThrow()
  })
})
