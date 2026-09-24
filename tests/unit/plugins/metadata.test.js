import { describe, expect, it } from "vitest"
import {
  clearMetadataCache,
  dirNameFromKey,
  legacyMetadata,
  readMetadata,
  validateMetadata,
} from "../../../lib/plugins/metadata.js"

describe("dirNameFromKey", () => {
  it("散装插件文件取一级目录", () => {
    expect(dirNameFromKey("system/status.js")).toBe("system")
    expect(dirNameFromKey("example/主动复读.js")).toBe("example")
  })

  it("目录型插件返回自身", () => {
    expect(dirNameFromKey("miao-plugin")).toBe("miao-plugin")
  })
})

describe("legacyMetadata（旧插件合成）", () => {
  it("合成结果不带任何限制，来源标记为 legacy", () => {
    expect(legacyMetadata("foo")).toEqual({
      name: "foo",
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
    })
  })

  it("空对象走 declared 路径的结果与合成结果逐字段一致", () => {
    // 这是「缺失 plugin.json」与「写了空的 plugin.json」行为相同的前提
    const { metadata, errors, warnings } = validateMetadata({}, "foo")
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect({ ...metadata, source: "legacy" }).toEqual(legacyMetadata("foo"))
  })
})

describe("validateMetadata", () => {
  it("接受完整的声明", () => {
    const { metadata, errors, warnings } = validateMetadata(
      {
        name: "demo",
        version: "1.2.3",
        description: "示例",
        author: "me",
        repo: "https://example.com/x.git",
        yunzai: ">=3.1.0",
        platforms: ["onebot11", "milky"],
        capabilities: ["message"],
        config: { schema: "config.schema.json", defaults: "config.default.json" },
        i18n: { "zh-cn": { hi: "你好" } },
      },
      "demo",
    )
    expect({ ...metadata, source: "legacy" }).toEqual({
      ...legacyMetadata("demo"),
      name: "demo",
      version: "1.2.3",
      description: "示例",
      author: "me",
      repo: "https://example.com/x.git",
      yunzai: ">=3.1.0",
      platforms: ["onebot11", "milky"],
      capabilities: ["message"],
      config: { schema: "config.schema.json", defaults: "config.default.json" },
      i18n: { "zh-cn": { hi: "你好" } },
    })
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it("已知字段类型不对时逐字段降级并告警", () => {
    const { metadata, warnings } = validateMetadata({ name: 1, platforms: "onebot11" }, "demo")
    expect(metadata.name).toBe("demo") // 回落到目录名
    expect(metadata.platforms).toEqual(["*"])
    expect(warnings).toHaveLength(2)
    expect(warnings.join()).toContain("name")
    expect(warnings.join()).toContain("platforms")
  })

  it("平台数组里混入非字符串时整体忽略并告警", () => {
    const { metadata, warnings } = validateMetadata({ platforms: ["onebot11", 1] }, "demo")
    expect(metadata.platforms).toEqual(["*"])
    expect(warnings).toHaveLength(1)
  })

  it("未知字段静默忽略（向前兼容）", () => {
    const { errors, warnings } = validateMetadata({ 未来的字段: 1, alsoUnknown: true }, "demo")
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it("config 支持 true 简写与对象两种写法", () => {
    expect(validateMetadata({ config: true }, "demo").metadata.config).toEqual({
      schema: "config.schema.json",
      defaults: null,
    })
    expect(validateMetadata({ config: {} }, "demo").metadata.config).toEqual({
      schema: "config.schema.json",
      defaults: null,
    })
    expect(validateMetadata({ config: "nope" }, "demo").metadata.config).toBeNull()
  })

  it("config 为 null 视为未声明", () => {
    expect(validateMetadata({ config: null }, "demo").metadata.config).toBeNull()
  })

  it("顶层不是对象时返回错误并退回合成结果", () => {
    for (const raw of [[], 1, "x", true]) {
      const { metadata, errors } = validateMetadata(raw, "demo")
      expect(errors).toHaveLength(1)
      expect({ ...metadata, source: "legacy" }).toEqual(legacyMetadata("demo"))
    }
  })

  it("platforms 为空数组时回落到通配", () => {
    expect(validateMetadata({ platforms: [] }, "demo").metadata.platforms).toEqual(["*"])
  })
})

describe("readMetadata（读盘 + 缓存）", () => {
  it("读取仓库内真实的 plugins/example/plugin.json", async () => {
    clearMetadataCache()
    const { metadata, exists, errors, warnings } = await readMetadata("example")
    expect(exists).toBe(true)
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    expect(metadata.source).toBe("declared")
    expect(metadata.name).toBe("yunzai-example")
    expect(metadata.version).toBe("1.0.0")
    expect(metadata.yunzai).toBe(">=3.1.0")
    expect(metadata.config).toEqual({ schema: "config.schema.json", defaults: null })
  })

  it("目录不存在时返回合成结果且不报错", async () => {
    clearMetadataCache()
    const { metadata, exists, errors, warnings } = await readMetadata("__不存在的插件目录__")
    expect(exists).toBe(false)
    expect(metadata).toEqual(legacyMetadata("__不存在的插件目录__"))
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
  })

  it("并发请求同一目录时复用同一次读盘（缓存的是 Promise）", () => {
    clearMetadataCache()
    expect(readMetadata("example")).toBe(readMetadata("example"))
  })

  it("refresh 会绕过缓存", () => {
    clearMetadataCache()
    const first = readMetadata("example")
    expect(readMetadata("example", { refresh: true })).not.toBe(first)
  })

  it("内置插件目录的元数据都可解析", async () => {
    for (const dir of ["system", "other", "example"]) {
      const { errors, warnings } = await readMetadata(dir, { refresh: true })
      expect(errors, dir).toEqual([])
      expect(warnings, dir).toEqual([])
    }
  })
})
