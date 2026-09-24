import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createConfigHandler, maskSecrets } from "../../../lib/web/api/config.js"
import { createPluginsHandler } from "../../../lib/web/api/plugins.js"
import { createSchemasHandler } from "../../../lib/web/api/schemas.js"
import { createStatusHandler } from "../../../lib/web/api/status.js"

/**
 * 只读 API 的测试。
 *
 * 这里直接调用处理器并断言响应体：路由层（404、限流、体积上限、鉴权）已经在
 * `server.test.js` 用真实 HTTP 验过，重复一遍只会让这一组变慢。
 */

/** 临时目录，afterEach 清掉 */
const temps = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

/**
 * 造一个可链式调用的最小响应对象，并记录 `send` 的内容。
 *
 * @returns {Record<string, unknown>} 响应替身
 */
function resOf() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      res.headers[name] = value
      return res
    },
    status(code) {
      res.statusCode = code
      return res
    },
    type(value) {
      res.headers["content-type"] = value
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
 * 调一次处理器，返回解析后的 JSON 与状态码。
 *
 * @param {Function} handler 处理器
 * @param {Record<string, unknown>} [req] 请求替身
 * @returns {Promise<{ status: number, json: any }>} 结果
 */
async function call(handler, req = {}) {
  const res = resOf()
  await handler(req, res, err => {
    throw err
  })
  return { status: res.statusCode, json: JSON.parse(String(res.body ?? "null")) }
}

/**
 * 造一个临时配置目录对。
 *
 * @param {Record<string, string>} userFiles 用户侧文件
 * @param {Record<string, string>} defaultFiles 默认侧文件
 * @returns {Promise<{ configDir: string, defaultsDir: string }>} 目录
 */
async function makeConfigDirs(userFiles, defaultFiles) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-web-config-"))
  temps.push(root)
  const configDir = path.join(root, "config")
  const defaultsDir = path.join(root, "default_config")
  for (const [dir, files] of [
    [configDir, userFiles],
    [defaultsDir, defaultFiles],
  ]) {
    await fs.mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(files))
      await fs.writeFile(path.join(dir, name), text, "utf8")
  }
  return { configDir, defaultsDir }
}

describe("GET /status", () => {
  it("返回版本、运行时长、内存、运行时与插件计数", async () => {
    const loader = { priority: [{}, {}, {}], pluginCount: 3, task: [{}] }
    const { status, json } = await call(
      createStatusHandler({ onlineOf: () => 2, version: "9.9.9", loader, hostOf: () => ({}) }),
      {},
    )

    expect(status).toBe(200)
    expect(json.version).toBe("9.9.9")
    expect(json.online).toBe(2)
    expect(json.uptime).toBeGreaterThanOrEqual(0)
    expect(json.memory.rss).toBeGreaterThan(0)
    expect(json.runtime.node).toBe(process.version)
    expect(json.plugins).toEqual({ handlers: 3, loaded: 3, tasks: 1 })
    expect(Array.isArray(json.adapters)).toBe(true)
  })

  it("账号列表来自宿主的 uin，且不猜在线状态", async () => {
    const { json } = await call(
      createStatusHandler({ hostOf: () => ({ uin: [12345, "stdin"] }) }),
      {},
    )
    expect(json.accounts).toEqual([{ uin: "12345" }, { uin: "stdin" }])
  })

  it("宿主替身缺字段时不抛错（缺 uin / 缺 loader）", async () => {
    const { status, json } = await call(createStatusHandler({ hostOf: () => ({}) }), {})
    expect(status).toBe(200)
    expect(json.accounts).toEqual([])
    expect(json.plugins).toEqual({ handlers: 0, loaded: 0, tasks: 0 })
  })

  it("旧字段名 plugin_count 也认（API 不因为一次改名返回 0）", async () => {
    const { json } = await call(
      createStatusHandler({ loader: { priority: [{}], plugin_count: 7 } }),
      {},
    )
    expect(json.plugins.loaded).toBe(7)
  })
})

describe("GET /plugins", () => {
  it("按加载顺序返回，并把 RegExp 规则摊平成可序列化的摘要", async () => {
    const loader = {
      priority: [
        {
          name: "状态统计",
          namespace: "system",
          key: "status",
          priority: 100,
          plugin: { dsc: "#状态", event: "message", rule: [{ reg: /^#状态/, fnc: "status" }] },
        },
        {
          name: "复读机",
          namespace: "example",
          key: "repeat",
          priority: 500,
          plugin: { event: ["message.group", "message.private"], rule: [] },
        },
      ],
    }

    const { status, json } = await call(createPluginsHandler({ loader }), {})
    expect(status).toBe(200)
    expect(json.total).toBe(2)
    expect(json.plugins[0]).toEqual({
      name: "状态统计",
      namespace: "system",
      key: "status",
      priority: 100,
      description: "#状态",
      events: ["message"],
      rules: [{ reg: "^#状态", fnc: "status", permission: null, log: null }],
    })
    // 顺序就是执行顺序，不能被排序改写
    expect(json.plugins.map(plugin => plugin.key)).toEqual(["status", "repeat"])
    expect(json.plugins[1].events).toEqual(["message.group", "message.private"])
  })

  it("loader 缺失时返回空列表而不是抛错", async () => {
    const { status, json } = await call(createPluginsHandler(), {})
    expect(status).toBe(200)
    expect(json).toEqual({ total: 0, plugins: [] })
  })
})

describe("GET /config", () => {
  it("清单列出全部文件（含两侧完全一致的），并给出差异条数", async () => {
    const dirs = await makeConfigDirs(
      { "bot.yaml": "log_level: info\n", "only-user.yaml": "a: 1\n" },
      { "bot.yaml": "log_level: info\nother: 1\n", "only-default.yaml": "b: 1\n" },
    )

    const { status, json } = await call(createConfigHandler(dirs), {})
    expect(status).toBe(200)
    expect(json.files.map(file => file.name)).toEqual([
      "bot.yaml",
      "only-default.yaml",
      "only-user.yaml",
    ])

    const bot = json.files.find(file => file.name === "bot.yaml")
    expect(bot.status).toBe("both")
    expect(bot.differences).toEqual({ missing: 1, extra: 0, changed: 0 })
    // 完全一致的文件也要出现在清单里（否则它看起来像"不存在"）
    expect(json.files.find(file => file.name === "only-user.yaml").status).toBe("only-user")
    expect(json.files.find(file => file.name === "only-default.yaml").status).toBe("only-default")
  })

  it("指定文件时返回两侧的值，并列出被脱敏的路径", async () => {
    const dirs = await makeConfigDirs(
      { "server.yaml": "port: 2536\nauth:\n  Authorization: Bearer SECRET\n" },
      { "server.yaml": "port: 2536\nauth:\n" },
    )

    const { json } = await call(createConfigHandler(dirs), { params: { name: "server.yaml" } })
    expect(json.status).toBe("both")
    expect(json.user.port).toBe(2536)
    expect(json.user.auth).toBe("***")
    expect(json.redacted).toEqual(["auth"])
    expect(JSON.stringify(json)).not.toContain("SECRET")
  })

  it("文件名过不了白名单时返回 400（路径穿越不可能通过）", async () => {
    const dirs = await makeConfigDirs({}, {})
    const handler = createConfigHandler(dirs)

    for (const file of ["../package.json", "a/b.yaml", "..\\b.yaml", "bot.txt", "C:\\x.yaml"]) {
      const { status, json } = await call(handler, { params: { name: file } })
      expect(status, `${file} 应该被拒`).toBe(400)
      expect(json.code).toBe("bad_request")
    }
  })

  it("文件不存在时返回 404", async () => {
    const dirs = await makeConfigDirs({}, {})
    const { status, json } = await call(createConfigHandler(dirs), {
      params: { name: "nope.yaml" },
    })
    expect(status).toBe(404)
    expect(json.code).toBe("not_found")
  })

  it("目录不存在时清单为空而不抛错", async () => {
    const { status, json } = await call(
      createConfigHandler({ configDir: "不存在的目录/x", defaultsDir: "不存在的目录/y" }),
      {},
    )
    expect(status).toBe(200)
    expect(json.files).toEqual([])
  })
})

describe("GET /config/schemas", () => {
  it("返回已建模文件的 schema 与未建模名单", async () => {
    const { status, json } = await call(
      createSchemasHandler({
        schemas: { "bot.yaml": { type: "object", title: "行为", properties: {} } },
        unmodeled: { "group.yaml": "顶层是动态键，表达不了" },
      }),
      {},
    )

    expect(status).toBe(200)
    expect(json.schemas["bot.yaml"].title).toBe("行为")
    expect(json.unmodeled).toEqual([{ name: "group.yaml", reason: "顶层是动态键，表达不了" }])
  })

  it("真实 schema 表里 7 个配置文件都在，且都是顶层 object", async () => {
    const { json } = await call(createSchemasHandler(), {})
    const names = Object.keys(json.schemas).sort()
    expect(names).toEqual([
      "bot.yaml",
      "milky.yaml",
      "other.yaml",
      "redis.yaml",
      "renderer.yaml",
      "satori.yaml",
      "server.yaml",
    ])
    for (const [name, schema] of Object.entries(json.schemas)) {
      expect(schema.type, `${name} 的顶层应当是 object`).toBe("object")
      expect(schema.title, `${name} 缺 title`).toBeTruthy()
    }
  })

  it("未建模名单带原因（前端要区分「只能原始编辑」与「漏了」）", async () => {
    const { json } = await call(createSchemasHandler(), {})
    const names = json.unmodeled.map(item => item.name).sort()
    expect(names).toEqual(["db.yaml", "group.yaml"])
    for (const item of json.unmodeled) expect(item.reason.length).toBeGreaterThan(10)
  })

  it("是深拷贝：调用方改返回值不会污染模块级单例", async () => {
    const first = await call(createSchemasHandler(), {})
    first.json.schemas["bot.yaml"].title = "被改过"
    const second = await call(createSchemasHandler(), {})
    expect(second.json.schemas["bot.yaml"].title).toBe("行为与日志")
  })
})

describe("maskSecrets", () => {
  it("遮住密钥类的键，并在数组元素里也生效", () => {
    const { value, paths } = maskSecrets({
      server: { auth: { A: "t" } },
      redis: { password: "p" },
      https: { key: "config/x.key" },
      list: [{ token: "t" }, { plain: 1 }],
    })
    expect(value.server.auth).toBe("***")
    expect(value.redis.password).toBe("***")
    // key 刻意不遮：它是证书路径，遮了反而难排查
    expect(value.https.key).toBe("config/x.key")
    expect(value.list[0].token).toBe("***")
    expect(value.list[1].plain).toBe(1)
    expect(paths).toEqual(["server.auth", "redis.password", "list[0].token"])
  })

  it("空值不遮（`auth:` 留空是正常配置，遮住它会让人以为配过）", () => {
    const { value, paths } = maskSecrets({ auth: null, other: "" })
    expect(value.auth).toBeNull()
    expect(paths).toEqual([])
  })
})
