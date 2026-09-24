import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import YAML from "yaml"
import { createPluginToggleHandler } from "../../../lib/web/api/plugin-toggle.js"

/**
 * 插件启停的测试。
 *
 * 写的是 `group.yaml` 的 `default.disable`，所以这里盯两件事：
 *
 * 1. **名单的增删是否只动了它自己**（别的键与注释必须原样留着）；
 * 2. **写完有没有打掉配置缓存**——`lib/config/config.js` 的解析缓存 + 5 秒防抖
 *    会让"刚写完立刻读"拿到旧值，而这条路径的全部价值就是"立刻生效"。
 */

let root
let dirs

/** 造一个最小响应对象 */
function resOf() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code
      return res
    },
    set() {
      return res
    },
    type() {
      return res
    },
    send(body) {
      res.body = body
      return res
    },
  }
  return res
}

/**
 * 调一次处理器。
 *
 * @param {object} handler 处理器
 * @param {object} req 请求替身
 * @returns {Promise<{status: number, json: any}>} 结果
 */
async function call(handler, req) {
  const res = resOf()
  // 处理器签名是 (req, res, next)；next 只在内部抛错时被调用
  await handler(req, res, err => {
    throw err
  })
  return { status: res.statusCode, json: res.body ? JSON.parse(String(res.body)) : undefined }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-toggle-"))
  dirs = {
    configDir: path.join(root, "config"),
    backupDir: path.join(root, "backups"),
  }
  await fs.mkdir(dirs.configDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * 写入一个初始 group.yaml。
 *
 * @param {string} text 内容
 * @returns {Promise<void>} 无
 */
async function seed(text) {
  await fs.writeFile(path.join(dirs.configDir, "group.yaml"), text, "utf8")
}

/**
 * 读回 group.yaml。
 *
 * @returns {Promise<string>} 内容
 */
function readGroup() {
  return fs.readFile(path.join(dirs.configDir, "group.yaml"), "utf8")
}

describe("PUT /api/v1/plugins/{name}", () => {
  it("停用：把插件名加进 default.disable，且**保留其它键与注释**", async () => {
    await seed("# 群配置\ndefault:\n  # 全局停用名单\n  groupCD: 500\n  disable:\n    - 已有的\n")
    const reload = vi.fn()
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload } })

    const { status, json } = await call(handler, {
      params: { name: "复读机" },
      body: { enabled: false },
    })

    expect(status).toBe(200)
    expect(json.enabled).toBe(false)
    expect(json.disableList).toEqual(["已有的", "复读机"])
    // 立刻生效，不需要重启
    expect(json.restartRequired).toBe(false)

    const text = await readGroup()
    // 注释与别的键都还在
    expect(text).toContain("# 群配置")
    expect(text).toContain("# 全局停用名单")
    expect(text).toContain("groupCD: 500")
    expect(YAML.parse(text).default.disable).toEqual(["已有的", "复读机"])
    expect(reload).toHaveBeenCalledWith("group")
  })

  it("启用：从 default.disable 移除", async () => {
    await seed("default:\n  disable:\n    - 甲\n    - 乙\n")
    const reload = vi.fn()
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload } })

    const { status, json } = await call(handler, {
      params: { name: "甲" },
      body: { enabled: true },
    })

    expect(status).toBe(200)
    expect(json.disableList).toEqual(["乙"])
    expect(YAML.parse(await readGroup()).default.disable).toEqual(["乙"])
  })

  it("没有变化时不写盘（也不留备份）", async () => {
    await seed("default:\n  disable:\n    - 甲\n")
    const before = await fs.readFile(path.join(dirs.configDir, "group.yaml"), "utf8")
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })

    // 甲本来就在名单里，再停用一次 = 没变化
    const { status, json } = await call(handler, {
      params: { name: "甲" },
      body: { enabled: false },
    })

    expect(status).toBe(200)
    expect(json.note).toContain("没有变化")
    expect(json.backup).toBeNull()
    expect(await readGroup()).toBe(before)
  })

  it("group.yaml 不存在时也能停用（从零建出 default.disable）", async () => {
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })

    const { status, json } = await call(handler, {
      params: { name: "新插件" },
      body: { enabled: false },
    })

    expect(status).toBe(200)
    expect(json.disableList).toEqual(["新插件"])
    // 原文件不存在 → 没有东西可备份
    expect(json.backup).toBeNull()
    expect(YAML.parse(await readGroup()).default.disable).toEqual(["新插件"])
  })

  it("写前备份原内容（把插件停用回去能靠它）", async () => {
    await seed("default:\n  disable:\n    - 甲\n")
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })

    const { json } = await call(handler, { params: { name: "乙" }, body: { enabled: false } })

    expect(json.backup).toBeTruthy()
    // 备份里是**改动前**的内容
    expect(await fs.readFile(json.backup, "utf8")).toContain("- 甲")
    expect(await fs.readFile(json.backup, "utf8")).not.toContain("- 乙")
  })

  it("请求体不合法时 400，且不碰文件", async () => {
    await seed("default:\n  disable: []\n")
    const before = await readGroup()
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })

    for (const body of [{}, { enabled: "yes" }, null]) {
      const { status, json } = await call(handler, { params: { name: "甲" }, body })
      expect(status, JSON.stringify(body)).toBe(400)
      expect(json.code).toBe("bad_request")
      expect(json.message).toContain("enabled")
    }
    expect(await readGroup()).toBe(before)
  })

  it("缺少插件名时 400", async () => {
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })
    const { status, json } = await call(handler, { params: {}, body: { enabled: false } })
    expect(status).toBe(400)
    expect(json.message).toContain("插件名")
  })

  it("group.yaml 是坏 YAML 时 400 并说明（不能让面板把它改得更坏）", async () => {
    await seed("default:\n  disable: [未闭合\n")
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })

    const { status, json } = await call(handler, {
      params: { name: "甲" },
      body: { enabled: false },
    })

    expect(status).toBe(400)
    expect(json.message).toContain("不是合法 YAML")
  })

  it("如实说明「群段可以盖过全局停用」这个边界", async () => {
    await seed("default:\n  disable: []\n")
    const handler = createPluginToggleHandler({ ...dirs, cfgRef: { reload: vi.fn() } })

    const { json } = await call(handler, { params: { name: "甲" }, body: { enabled: false } })
    // 界面把那句直接显示给用户，比界面自己编一句更准
    expect(json.note).toContain("enable")
    expect(json.note).toContain("盖过")
  })
})
