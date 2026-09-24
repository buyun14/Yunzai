import path from "node:path"
import { describe, expect, it } from "vitest"
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
