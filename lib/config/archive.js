import fs from "node:fs/promises"
import path from "node:path"
import { stampOf } from "./backup.js"
import { runMigrations } from "./migrate.js"
import { readVersion } from "./version.js"
import { createZip, readZip } from "./zip.js"

/**
 * 备份包：`node . backup` / `node . restore`。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.4。
 *
 * # 与 `backup.js` 的分工
 *
 * `backup.js` 是**保险绳**：迁移前把 `config/config/` 原样拷一份到 `config/backups/`，
 * 要求极简单、能手工复原。本模块是**可携带的逻辑包**：带 manifest、带版本号、
 * 能拿到另一台机器上还原，所以有格式、有排除规则、有校验。两者刻意不合并。
 *
 * # 不备份什么（都有理由）
 *
 * | 排除 | 为什么 |
 * |---|---|
 * | `node_modules` / `.git` | 能装回来，且体积远大于配置本身 |
 * | `temp` / `logs` | 可再生，且 `temp/` 里是渲染产物，可能有几 GB |
 * | `config/backups/` | 那是"旧备份"，打进包里会让包一代代变大 |
 * | redis | 按 §3.3 的定义其中的数据可重建 |
 *
 * # 恢复的两条硬约束
 *
 * 1. **先给当前状态打一个包**。恢复本身也可能是一次误操作，不先留一份，
 *    用户就没有第二次机会了。
 * 2. **路径必须落在根目录内**。条目名来自包文件，一个损坏或被改造过的包
 *    完全可能带 `../../` 或绝对路径。恢复会往磁盘写东西，这种检查不是洁癖。
 */

/** 包格式版本。改包结构时 +1；恢复时校验，不匹配直接拒绝 */
export const FORMAT_VERSION = 1

/**
 * 备份包的 manifest。
 *
 * 写成 typedef 而不是 `Record<string, unknown>`：调用方（`app.js` 的 CLI）要读
 * `entries.length` / `scope.join()` / `config_version`，不写清就是一串 TS2339。
 *
 * @typedef {object} ArchiveManifest
 * @property {number} format_version 包格式版本
 * @property {string} [yunzai_version] 导出时的程序版本
 * @property {number} [config_version] 导出时的配置版本
 * @property {string} created_at 导出时间（ISO）
 * @property {string[]} scope 打包范围
 * @property {Array<{ name: string, bytes: number }>} entries 条目清单
 * @property {number} plugins 插件目录数
 */

/**
 * 插件清单的一项。
 *
 * `metadata` 是可选的：没有 `plugin.json` 的旧插件只能记下目录名，
 * 硬写必选会逼着调用方去编一份假元数据。
 *
 * @typedef {object} PluginEntry
 * @property {string} dir 插件目录名
 * @property {Record<string, unknown>} [metadata] `plugin.json` 的内容
 */

/** 任意层级都不要的目录名 */
export const EXCLUDED_DIR_NAMES = ["node_modules", ".git", "temp", "logs"]

/** 不要的目录路径（相对根目录） */
export const EXCLUDED_DIR_PATHS = ["config/backups"]

/** 默认打包范围 */
export const DEFAULT_SCOPE = ["config/config", "data"]

/** 包里代表"包自身元信息"的条目，恢复时不落盘（否则会在项目根目录多出两个文件） */
export const METADATA_ENTRIES = ["manifest.json", "plugins.manifest.json"]

/** 按扩展名决定是否压缩。已经压过的格式再 deflate 一遍只是白费 CPU */
const COMPRESSED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".gz", ".7z", ".mp4", ".mp3", ".silk"]

/**
 * 收集一个目录下的全部文件。
 *
 * 符号链接**跳过**：`isFile()` 对它会返回 false。备份不该顺着链接跑到根目录外面去。
 *
 * @param {string} absolute 绝对（或相对 cwd 的）目录
 * @param {string} relative 该目录相对打包根的路径，会作为条目名的前缀
 * @param {Array<{ name: string, absolute: string }>} out 收集结果（就地追加）
 * @returns {Promise<Array<{ name: string, absolute: string }>>} 同一个数组
 */
async function walk(absolute, relative, out) {
  let entries
  try {
    entries = await fs.readdir(absolute, { withFileTypes: true })
  } catch {
    return out // 目录不存在：没什么可打包的，不是错误
  }

  for (const entry of entries) {
    const name = `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.includes(entry.name) || EXCLUDED_DIR_PATHS.includes(name)) continue
      await walk(path.join(absolute, entry.name), name, out)
    } else if (entry.isFile()) out.push({ name, absolute: path.join(absolute, entry.name) })
  }

  return out
}

/**
 * 插件清单：目录名 + 元数据。不含 `node_modules`，也没有文件内容。
 *
 * 目的是让拿到包的人知道"这份配置是在装了哪些插件的情况下导出的"——
 * 少一个插件时配置里的段会变成"多余"，排查时这是第一条线索。
 *
 * @param {string} pluginsDir 插件目录
 * @returns {Promise<PluginEntry[]>} 清单
 */
async function pluginManifest(pluginsDir) {
  let names
  try {
    names = (await fs.readdir(pluginsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return [] // 还没有 plugins/ 目录
  }

  const manifest = []
  for (const dir of names) {
    try {
      const text = await fs.readFile(path.join(pluginsDir, dir, "plugin.json"), "utf8")
      manifest.push({ dir, metadata: JSON.parse(text) })
    } catch {
      // 没有 plugin.json 的就是旧插件：只记目录名，不去猜它的元数据
      manifest.push({ dir })
    }
  }

  return manifest
}

/**
 * 读一个数值型的版本号，读不到返回 undefined。
 *
 * @returns {Promise<string|undefined>} 版本号
 */
async function readOwnVersion() {
  try {
    const pkg = JSON.parse(await fs.readFile("package.json", "utf8"))
    return typeof pkg.version === "string" ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 打一个备份包。
 *
 * @param {{ root?: string, scope?: string[], now?: Date }} [options] 选项
 * @returns {Promise<{ manifest: ArchiveManifest, buffer: Buffer }>} manifest 与包内容
 */
export async function buildArchive({ root = ".", scope = DEFAULT_SCOPE, now = new Date() } = {}) {
  const files = []
  for (const dir of scope) await walk(path.join(root, dir), dir, files)

  const entries = []
  for (const file of files)
    entries.push({
      name: file.name,
      data: await fs.readFile(file.absolute),
      compress: !COMPRESSED_EXTENSIONS.includes(path.extname(file.name).toLowerCase()),
    })

  const plugins = await pluginManifest(path.join(root, "plugins"))
  const manifest = {
    format_version: FORMAT_VERSION,
    yunzai_version: await readOwnVersion(),
    config_version: await readVersion(path.join(root, ...DEFAULT_SCOPE[0].split("/"))),
    created_at: now.toISOString(),
    scope,
    entries: entries.map(entry => ({ name: entry.name, bytes: entry.data.length })),
    plugins: plugins.length,
  }

  entries.unshift({
    name: METADATA_ENTRIES[0],
    data: JSON.stringify(manifest, null, 2),
  })
  entries.push({
    name: METADATA_ENTRIES[1],
    data: JSON.stringify(plugins, null, 2),
  })

  return { manifest, buffer: createZip(entries) }
}

/**
 * 写一个备份包到磁盘。
 *
 * @param {string} file 目标路径
 * @param {Buffer} buffer 包内容
 * @returns {Promise<string>} 目标路径
 */
export async function writeArchive(file, buffer) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true })
  await fs.writeFile(file, buffer)
  return file
}

/**
 * 检查条目名是否安全（必须落在根目录内）。
 *
 * @param {string[]} names 条目名
 * @returns {void}
 */
export function assertSafeNames(names) {
  for (const name of names) {
    const parts = name.split("/")
    const unsafe =
      !name ||
      name.startsWith("/") ||
      /^[a-zA-Z]:/.test(name) ||
      parts.includes("..") ||
      parts.includes("")
    if (unsafe) throw new Error(`包里的路径 ${JSON.stringify(name)} 不安全（绝对路径或向上穿越），拒绝恢复`)
  }
}

/**
 * 读一个备份包并校验 manifest。
 *
 * @param {string} file 包路径
 * @returns {Promise<{ manifest: ArchiveManifest, entries: Array<{ name: string, data: Buffer }> }>} 内容
 */
export async function readArchive(file) {
  const entries = readZip(await fs.readFile(file))
  assertSafeNames(entries.map(entry => entry.name))

  const metadata = entries.find(entry => entry.name === METADATA_ENTRIES[0])
  if (!metadata) throw new Error(`${file} 里没有 manifest.json，不是本仓生成的备份包`)

  const manifest = /** @type {ArchiveManifest} */ (JSON.parse(metadata.data.toString("utf8")))
  if (manifest.format_version !== FORMAT_VERSION)
    throw new Error(
      `备份包的格式版本是 ${manifest.format_version}，本版本只认 ${FORMAT_VERSION}；请用生成该包的版本恢复`,
    )

  return { manifest, entries }
}

/**
 * 从备份包恢复。
 *
 * 恢复是**覆盖**语义：只写包里的文件，不删除目标里多出来的文件。
 * 想彻底回到包里的状态，先手动清空再恢复——本函数不替用户做删除决定。
 *
 * @param {string} file 包路径
 * @param {{ root?: string, backupDir?: string, now?: Date, migrate?: boolean }} [options] 选项
 * @returns {Promise<{ manifest: ArchiveManifest, restored: number, previous: string, migration: { from: number, to: number, applied: string[] } | null }>} 结果（含恢复前那份包的位置）
 */
export async function restoreArchive(file, {
  root = ".",
  backupDir = "config/backups",
  now = new Date(),
  migrate = true,
} = {}) {
  const { manifest, entries } = await readArchive(file)

  // 1. 先给当前状态打一个包：恢复本身也可能是误操作
  const previous = await buildArchive({ root, now })
  const previousFile = await writeArchive(
    path.join(root, backupDir, `pre-restore-${stampOf(now)}.zip`),
    previous.buffer,
  )

  // 2. 落盘。manifest 与插件清单是包自身的元信息，不写进项目根目录
  let restored = 0
  for (const entry of entries) {
    if (METADATA_ENTRIES.includes(entry.name)) continue
    const target = path.join(root, ...entry.name.split("/"))
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.data)
    restored++
  }

  // 3. 按包里的 config_version 补跑迁移：包可能是旧版本导出的，
  //    直接把它丢回项目里等于把配置降级——迁移是唯一能把两者对齐的东西。
  //    backupRoot 必须跟着 root 走，否则迁移前的备份会被写进**当前工作目录**
  //    的 config/backups/（测试里就是对真实的那个动手了）。
  const migration = migrate
    ? await runMigrations({
        configDir: path.join(root, ...DEFAULT_SCOPE[0].split("/")),
        backupRoot: path.join(root, backupDir),
        now,
      })
    : null

  return { manifest, restored, previous: previousFile, migration }
}
