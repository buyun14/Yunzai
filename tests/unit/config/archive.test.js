import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertSafeNames,
  buildArchive,
  FORMAT_VERSION,
  readArchive,
  restoreArchive,
  writeArchive,
} from "../../../lib/config/archive.js"
import { createZip, readZip } from "../../../lib/config/zip.js"

/**
 * 备份包（阶段 5 §3.4）。
 *
 * 对应的验收项（`05-persistence-config.md` §6）：「`node . backup` 生成的包能在
 * 干净目录中 `node . restore` 成功还原配置」。
 *
 * 全部在一个**假的临时项目**里跑：`root/` 下自造 `config/`、`data/`、`temp/`、
 * `logs/`、`node_modules/`、`plugins/`。绝不碰真实的仓库目录。
 */

let root
let configDir

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-archive-"))
  configDir = path.join(root, "config", "config")
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(path.join(root, "data"), { recursive: true })
  await fs.mkdir(path.join(root, "temp"), { recursive: true })
  await fs.mkdir(path.join(root, "logs"), { recursive: true })
  await fs.mkdir(path.join(root, "node_modules", "some-dep"), { recursive: true })
  await fs.mkdir(path.join(root, "config", "backups", "old"), { recursive: true })
  await fs.mkdir(path.join(root, "plugins", "demo-plugin"), { recursive: true })
  await fs.mkdir(path.join(root, "plugins", "旧插件"), { recursive: true })

  await fs.writeFile(path.join(configDir, "other.yaml"), "masterQQ:\n  - 12345\n")
  await fs.writeFile(path.join(configDir, "_meta.json"), '{"config_version":2}\n')
  await fs.writeFile(path.join(root, "data", "note.txt"), "用户数据\n")
  await fs.writeFile(path.join(root, "temp", "render.png"), "不该进包")
  await fs.writeFile(path.join(root, "logs", "app.log"), "不该进包")
  await fs.writeFile(path.join(root, "node_modules", "some-dep", "index.js"), "不该进包")
  await fs.writeFile(path.join(root, "config", "backups", "old", "keep.yaml"), "不该进包")
  await fs.writeFile(
    path.join(root, "plugins", "demo-plugin", "plugin.json"),
    '{"name":"demo-plugin","version":"1.0.0"}\n',
  )
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** 把包写到临时目录里并返回路径 */
async function writeTempArchive(name = "backup.zip", options = {}) {
  const { buffer } = await buildArchive({ root, ...options })
  return writeArchive(path.join(root, name), buffer)
}

describe("buildArchive：范围与排除", () => {
  it("包含 config/config 与 data，排除 node_modules / temp / logs / config/backups", async () => {
    const { manifest } = await buildArchive({ root })
    const names = manifest.entries.map((/** @type {{name: string}} */ entry) => entry.name)

    expect(names).toContain("config/config/other.yaml")
    expect(names).toContain("data/note.txt")
    for (const excluded of [
      "node_modules/some-dep/index.js",
      "temp/render.png",
      "logs/app.log",
      "config/backups/old/keep.yaml",
    ])
      expect(names, `${excluded} 不该进包`).not.toContain(excluded)
  })

  it("manifest 记录格式版本、配置版本与导出时间", async () => {
    const now = new Date("2026-09-24T11:30:00Z")
    const { manifest } = await buildArchive({ root, now })

    expect(manifest.format_version).toBe(FORMAT_VERSION)
    expect(manifest.config_version).toBe(2)
    expect(manifest.created_at).toBe(now.toISOString())
    expect(manifest.scope).toEqual(["config/config", "data"])
  })

  it("插件清单：有 plugin.json 的带元数据，没有的只有目录名", async () => {
    const { buffer } = await buildArchive({ root })
    const entry = readZip(buffer).find(item => item.name === "plugins.manifest.json")
    const plugins = JSON.parse(String(entry?.data.toString("utf8")))

    expect(plugins).toEqual([
      { dir: "demo-plugin", metadata: { name: "demo-plugin", version: "1.0.0" } },
      { dir: "旧插件" },
    ])
  })

  it("目录不存在时也能打包（空范围不是错误）", async () => {
    const { manifest } = await buildArchive({ root, scope: ["这也没有", "data"] })
    expect(manifest.entries.map((/** @type {{name: string}} */ e) => e.name)).toEqual([
      "data/note.txt",
    ])
  })
})

describe("assertSafeNames：拒绝越界路径", () => {
  it("向上穿越、绝对路径、Windows 盘符都拒绝", () => {
    for (const bad of ["../evil", "a/../../evil", "/etc/passwd", "C:/Windows/x", ""])
      expect(() => assertSafeNames([bad]), bad).toThrow(/不安全/)
  })

  it("正常相对路径通过", () => {
    expect(() => assertSafeNames(["config/config/other.yaml", "data/中文.txt"])).not.toThrow()
  })
})

describe("readArchive：校验", () => {
  it("正常包能读出 manifest", async () => {
    const file = await writeTempArchive()
    const { manifest } = await readArchive(file)
    expect(manifest.format_version).toBe(FORMAT_VERSION)
  })

  it("格式版本不匹配时拒绝，并说清原因", async () => {
    const zip = createZip([
      { name: "manifest.json", data: JSON.stringify({ format_version: 99 }) },
    ])
    const file = await writeArchive(path.join(root, "bad.zip"), zip)
    await expect(readArchive(file)).rejects.toThrow(/格式版本/)
  })

  it("没有 manifest 的包被拒绝", async () => {
    const zip = createZip([{ name: "config/config/other.yaml", data: "a: 1\n" }])
    const file = await writeArchive(path.join(root, "nomanifest.zip"), zip)
    await expect(readArchive(file)).rejects.toThrow(/manifest/)
  })
})

describe("restoreArchive：还原", () => {
  it("配置被改坏之后能还原回包里的样子", async () => {
    const file = await writeTempArchive()
    await fs.writeFile(path.join(configDir, "other.yaml"), "被改坏了\n")

    const result = await restoreArchive(file, { root })

    expect(await fs.readFile(path.join(configDir, "other.yaml"), "utf8")).toBe(
      "masterQQ:\n  - 12345\n",
    )
    expect(result.restored).toBeGreaterThan(0)
  })

  it("恢复前会给当前状态打一个包，且不会被写进包里（不递归膨胀）", async () => {
    const file = await writeTempArchive()

    const result = await restoreArchive(file, { root })
    const previous = path.join(root, "config", "backups", path.basename(String(result.previous)))

    expect(path.basename(String(result.previous))).toMatch(/^pre-restore-\d{8}-\d{6}\.zip$/)
    expect((await fs.stat(previous)).size).toBeGreaterThan(0)
    // 那个包自己不该包含 config/backups/
    const { manifest } = await readArchive(previous)
    expect(manifest.entries.map((/** @type {{name: string}} */ e) => e.name)).not.toContain(
      "config/backups/old/keep.yaml",
    )
  })

  it("覆盖语义：包里没有的文件不会被删掉", async () => {
    const file = await writeTempArchive()
    await fs.writeFile(path.join(configDir, "只有我.yaml"), "本地新增\n")

    await restoreArchive(file, { root })

    expect(await fs.readFile(path.join(configDir, "只有我.yaml"), "utf8")).toBe("本地新增\n")
  })

  it("manifest 与插件清单是包自身的元信息，不写进项目根目录", async () => {
    const file = await writeTempArchive()
    await restoreArchive(file, { root })

    await expect(fs.access(path.join(root, "manifest.json"))).rejects.toThrow()
    await expect(fs.access(path.join(root, "plugins.manifest.json"))).rejects.toThrow()
  })

  it("migrate: false 时不去动配置版本", async () => {
    const file = await writeTempArchive()
    const result = await restoreArchive(file, { root, migrate: false })

    expect(result.migration).toBeNull()
    expect(JSON.parse(await fs.readFile(path.join(configDir, "_meta.json"), "utf8"))).toEqual({
      config_version: 2,
    })
  })
})
