import fs from "node:fs/promises"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { readMetadata } from "../../../lib/plugins/metadata.js"
import { clearMetadataCache } from "../../../lib/plugins/metadata.js"
import { configFileFor, loadPluginConfig } from "../../../lib/plugins/plugin-config.js"

/** 与 plugins/example/config.schema.json 的 default 一致 */
const EXAMPLE_DEFAULTS = {
  repeat: { prompt: "请发送要复读的内容", recallSeconds: 5 },
  newcomer: { message: "欢迎新人！", cooldown: 30 },
  leaveNotice: { tips: "退群了" },
}

describe("configFileFor", () => {
  it("落在 config/plugin/<目录>.json（该目录被 .gitignore 覆盖）", () => {
    expect(configFileFor("example")).toBe(path.join("config", "plugin", "example.json"))
  })
})

describe("loadPluginConfig", () => {
  it("未声明 config 的插件不做任何事，保持与改造前一致", async () => {
    const result = await loadPluginConfig("system", { config: null })
    expect(result).toEqual({
      config: {},
      configFile: null,
      created: false,
      problems: [],
      fatal: false,
    })
  })

  it("只声明 schema、不声明 defaults 时不产生任何问题", async () => {
    // 回归测试：曾把空串交给 path.join，得到目录路径后读取报 EISDIR
    clearMetadataCache()
    const { metadata } = await readMetadata("example")
    expect(metadata.config).toEqual({ schema: "config.schema.json", defaults: null })

    const result = await loadPluginConfig("example", metadata)
    expect(result.problems).toEqual([])
  })

  it("按 schema 的 default 填出完整配置", async () => {
    clearMetadataCache()
    const { metadata } = await readMetadata("example")
    const { config } = await loadPluginConfig("example", metadata)
    expect(config).toEqual(EXAMPLE_DEFAULTS)
  })

  it("再次读取结果稳定（用户配置文件已存在时与默认值一致）", async () => {
    clearMetadataCache()
    const { metadata } = await readMetadata("example")
    const first = await loadPluginConfig("example", metadata)
    const second = await loadPluginConfig("example", metadata)
    expect(second.config).toEqual(first.config)
    expect(second.problems).toEqual([])
  })
})

/**
 * 「问题上报」分支的覆盖。
 *
 * # 为什么用假 metadata + 假目录名
 *
 * `loadPluginConfig` 的两处基准目录是**写死的相对路径**
 * （`plugins/<目录>` 与 `config/plugin/<目录>.json`），因此要驱动
 * `problems` 上的每一条文案，就得让这些路径指向可控的文件。
 *
 * 这里**刻意不在 `plugins/` 下创建任何临时目录**：`PluginsLoader.load()` 会扫描
 * 该目录，一个残留的临时目录会污染真实启动与 CI 冒烟测试。
 * 所以统一用不存在的目录名（让 `plugins/<x>/...` 自然 ENOENT），
 * 只操纵 `config/plugin/` 下的文件——那里被 `.gitignore` 整体覆盖，
 * 且只按插件目录名读取，放什么都不会被真实启动看到。
 *
 * 代价：`defaults` 命中与 schema 校验失败两条分支需要 `plugins/<目录>/` 下**真实存在**
 * 的文件，无法在不造临时目录的前提下触发，因此留作已知缺口
 * （见 `docs/refactor/03-engineering.md`；阶段 5 会重写这块配置持久化）。
 */
describe("loadPluginConfig：问题上报分支", () => {
  /** 本用例组创建的文件/目录，用后即删 */
  const created = /** @type {string[]} */ ([])
  // 注意 `__no_schema__`：它没在文件里显式创建，但 `declared === null` 会让模块**写出**一份
  const problemDirs = [
    "__bad_json__",
    "__array_top__",
    "__created__",
    "__no_schema__",
    "a",
    "__dir__",
  ]
  const problemFiles = problemDirs.map(name => path.join("config", "plugin", `${name}.json`))
  const writeFailFile = path.join("config", "plugin", "a", "b.json")

  afterAll(async () => {
    for (const file of [...problemFiles, writeFailFile, ...created])
      await fs.rm(file, { recursive: true, force: true })
    for (const dir of ["a"])
      await fs.rm(path.join("config", "plugin", dir), { recursive: true, force: true })
  })

  /**
   * 用一个不存在的插件目录名造 metadata，只让 config/plugin 下的文件生效。
   *
   * @param {string} dirName 目录名（可含斜杠，用于制造写出失败）
   * @returns {{ config: { schema: string, defaults: null } }} 假元数据
   */
  const meta = dirName => ({ config: { schema: `${dirName}.schema.json`, defaults: null } })

  it("配置文件不是合法 JSON 时上报，且不抛出", async () => {
    await fs.mkdir(path.join("config", "plugin"), { recursive: true })
    await fs.writeFile(problemFiles[0], "{ 这不是 JSON", "utf8")

    const result = await loadPluginConfig("__bad_json__", meta("__bad_json__"))
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/用户配置 .* 不是合法 JSON/)
    expect(result.config).toEqual({})
  })

  it("配置文件顶层是数组时上报（顶层必须是对象）", async () => {
    await fs.mkdir(path.join("config", "plugin"), { recursive: true })
    await fs.writeFile(problemFiles[1], "[]", "utf8")

    const result = await loadPluginConfig("__array_top__", meta("__array_top__"))
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/的顶层必须是对象/)
  })

  it("schema 文件缺失时退化为不做校验，直接采用合并结果", async () => {
    const result = await loadPluginConfig("__no_schema__", meta("__no_schema__"))
    // plugins/__no_schema__/... 不存在 → schema 读不到 → else 分支
    expect(result.problems).toEqual([])
    expect(result.config).toEqual({})
  })

  it("用户配置缺失时写出一份，并标记 created", async () => {
    await fs.rm(problemFiles[2], { force: true })
    created.push(problemFiles[2])

    const result = await loadPluginConfig("__created__", meta("__created__"))
    expect(result.created).toBe(true)
    expect(result.problems).toEqual([])
    await expect(fs.readFile(problemFiles[2], "utf8")).resolves.toContain("{}")
  })

  it("写出失败时上报，且 created 保持 false", async () => {
    // dirName 含斜杠 → config/plugin/a/b.json，而 config/plugin/a/ 不存在 → ENOENT
    const result = await loadPluginConfig("a/b", meta("a/b"))
    expect(result.created).toBe(false)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toMatch(/写出配置文件 .* 失败/)
  })

  it("读取遇到 ENOENT 之外的错误时上报（以目录冒充配置文件）", async () => {
    await fs.mkdir(path.join("config", "plugin", "__dir__.json"), { recursive: true })

    const result = await loadPluginConfig("__dir__", meta("__dir__"))
    // 级联：读失败 → declared 为 null → 又去写出同一个路径 → 同样失败
    expect(result.problems).toHaveLength(2)
    expect(result.problems[0]).toMatch(/读取用户配置 .* 失败/)
    expect(result.problems[1]).toMatch(/写出配置文件 .* 失败/)
    expect(result.created).toBe(false)
  })
})
