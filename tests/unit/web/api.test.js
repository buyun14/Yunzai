import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createConfigHandler, maskSecrets } from "../../../lib/web/api/config.js"
import { createConfigWriteHandler } from "../../../lib/web/api/config-write.js"
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
 * 造一个临时配置目录对（外加写前备份目录）。
 *
 * `backupDir` 必须一起给出：写入接口在没注入它时会回退到**仓库里真实的**
 * `config/backups/`，那样测试就会往工作区里拉屎（实测踩过）。
 *
 * @param {Record<string, string>} userFiles 用户侧文件
 * @param {Record<string, string>} defaultFiles 默认侧文件
 * @returns {Promise<{ configDir: string, defaultsDir: string, backupDir: string }>} 目录
 */
async function makeConfigDirs(userFiles, defaultFiles) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-web-config-"))
  temps.push(root)
  const configDir = path.join(root, "config")
  const defaultsDir = path.join(root, "default_config")
  const backupDir = path.join(root, "backups")
  for (const [dir, files] of [
    [configDir, userFiles],
    [defaultsDir, defaultFiles],
  ]) {
    await fs.mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(files))
      await fs.writeFile(path.join(dir, name), text, "utf8")
  }
  return { configDir, defaultsDir, backupDir }
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
      // 传入的 cfgRef 没有 getGroup，读不到停用名单 → 都算启用
      enabled: true,
    })
    // 顺序就是执行顺序，不能被排序改写
    expect(json.plugins.map(plugin => plugin.key)).toEqual(["status", "repeat"])
    expect(json.plugins[1].events).toEqual(["message.group", "message.private"])
  })

  it("按全局停用名单标出 enabled，且没有名字的条目给 null", async () => {
    const loader = {
      priority: [
        { name: "活着的", key: "a", plugin: { rule: [] } },
        { name: "被停用的", key: "b", plugin: { rule: [] } },
        // 没有 name 的条目无法用"按名字"的启停接口表达 → null，界面应禁用开关
        { name: null, key: "c", plugin: { rule: [] } },
      ],
    }
    const cfgRef = { getGroup: () => ({ disable: ["被停用的"] }) }

    const { json } = await call(createPluginsHandler({ loader, cfgRef }), {})
    expect(json.plugins.map(p => p.enabled)).toEqual([true, false, null])
  })

  it("停用名单读不到时不影响列表（不能让面板整体看不到插件）", async () => {
    const loader = { priority: [{ name: "x", key: "x", plugin: { rule: [] } }] }
    const cfgRef = {
      getGroup: () => {
        throw new Error("配置坏了")
      },
    }
    const { status, json } = await call(createPluginsHandler({ loader, cfgRef }), {})
    expect(status).toBe(200)
    expect(json.plugins[0].enabled).toBe(true)
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

describe("PUT /config/{name}", () => {
  it("写入成功：返回 name / written / backup / restartRequired", async () => {
    const dirs = await makeConfigDirs({ "bot.yaml": "log_level: info\n" }, {})
    const { status, json } = await call(createConfigWriteHandler(dirs), {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "debug" }, confirmed: true },
    })

    expect(status).toBe(200)
    expect(json.name).toBe("bot.yaml")
    expect(json.written).toBe(true)
    expect(json.restartRequired).toBe(true)
    expect(json.backup).toBeTruthy()

    const written = await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")
    expect(written).toContain("debug")
  })

  it("保留注释：改一个键不会把文件里的注释洗掉", async () => {
    const original = "# 日志等级，别乱改\nlog_level: info\n# 下面这行是端口\nport: 2536\n"
    const dirs = await makeConfigDirs({ "bot.yaml": original }, {})

    await call(createConfigWriteHandler(dirs), {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "warn" }, confirmed: true },
    })

    const written = await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")
    expect(written).toContain("# 日志等级，别乱改")
    expect(written).toContain("# 下面这行是端口")
    // 没提交的键原样保留（是"逐个 set"，不是整体替换）
    expect(written).toContain("port: 2536")
    expect(written).toContain("warn")
  })

  it("写前备份保留了原内容，且不覆盖已有备份", async () => {
    const dirs = await makeConfigDirs({ "bot.yaml": "log_level: info\n" }, {})
    const handler = createConfigWriteHandler(dirs)

    const first = await call(handler, {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "debug" }, confirmed: true },
    })
    await fs.writeFile(path.join(dirs.configDir, "bot.yaml"), "log_level: warn\n", "utf8")
    const second = await call(handler, {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "error" }, confirmed: true },
    })

    // 两次备份必须都能找到，且各自是当时的原内容
    const backups = await fs.readdir(dirs.backupDir)
    expect(backups.length).toBeGreaterThanOrEqual(2)
    expect(await fs.readFile(first.json.backup, "utf8")).toBe("log_level: info\n")
    expect(await fs.readFile(second.json.backup, "utf8")).toBe("log_level: warn\n")
    expect(first.json.backup).not.toBe(second.json.backup)
  })

  it("填上空键时不会把「下一行的注释」拽成行尾注释", async () => {
    // 出厂配置里空键很多（username / password / chromium_path …），而"把空键填上值"
    // 正是这个接口的主要用途。yaml 的 loader 会把空标量后面那行注释记成**它的**
    // 尾注释，一旦填上值就渲染成 `username: root # 密码`——注释归属错了，
    // 且是被我们的写入触发的。这条用例盯的就是这个。
    const original = "# 用户名\nusername:\n# 密码\npassword:\n# 数据库\ndb: 0\n"
    const dirs = await makeConfigDirs({ "redis.yaml": original }, {})

    const { status } = await call(createConfigWriteHandler(dirs), {
      params: { name: "redis.yaml" },
      body: { config: { username: "root" }, confirmed: true },
    })
    expect(status).toBe(200)

    const written = await fs.readFile(path.join(dirs.configDir, "redis.yaml"), "utf8")
    expect(written).toContain("username: root")
    // 关键断言：注释必须还在**自己那一行**，没有被挂到 username 后面
    expect(written).not.toContain("root # 密码")
    expect(written).toMatch(/# 密码\npassword:/)
    expect(written).toMatch(/# 用户名\nusername: root/)
    // 也不该因为搬注释而多出空行
    expect(written).not.toMatch(/\n\n/)
  })

  it("不改任何键时注释原样保留（round-trip 稳定）", async () => {
    const original = "# 用户名\nusername:\n# 密码\npassword:\n# 数据库\ndb: 0\n"
    const dirs = await makeConfigDirs({ "redis.yaml": original }, {})

    // 提交一个与现值相同的值：内容本身不变，注释也不该被搅动
    await call(createConfigWriteHandler(dirs), {
      params: { name: "redis.yaml" },
      body: { config: { db: 0 }, confirmed: true },
    })

    const written = await fs.readFile(path.join(dirs.configDir, "redis.yaml"), "utf8")
    expect(written).toBe(original)
  })

  it("拒绝未建模的文件（group.yaml / db.yaml），并说明原因", async () => {
    const dirs = await makeConfigDirs({ "group.yaml": "default:\n  groupCD: 500\n" }, {})
    const handler = createConfigWriteHandler(dirs)

    for (const name of ["group.yaml", "db.yaml"]) {
      const { status, json } = await call(handler, {
        params: { name },
        body: { config: {}, confirmed: true },
      })
      expect(status, `${name} 不该允许写入`).toBe(400)
      expect(json.message).toContain("未建模")
      // 必须告诉用户"那你去改哪里"
      expect(json.message).toContain("config/config/")
    }
  })

  it("封死敏感键：server.yaml 的 auth / https 一律拒绝", async () => {
    const dirs = await makeConfigDirs({ "server.yaml": "port: 2536\n" }, {})
    const handler = createConfigWriteHandler(dirs)

    for (const key of ["auth", "https"]) {
      const { status, json } = await call(handler, {
        params: { name: "server.yaml" },
        body: { config: { [key]: { Authorization: "x" } }, confirmed: true },
      })
      expect(status, `${key} 不该允许通过面板改`).toBe(400)
      expect(json.message).toContain(key)
      expect(json.message).toContain("鉴权与监听")
    }

    // 同一文件里**非敏感**的键照常可改（封的是键，不是整个文件）
    const ok = await call(handler, {
      params: { name: "server.yaml" },
      body: { config: { port: 3000 }, confirmed: true },
    })
    expect(ok.status).toBe(200)
  })

  it("校验不过就不写盘（值非法 + 未知键的类型检查）", async () => {
    const dirs = await makeConfigDirs({ "bot.yaml": "log_level: info\n" }, {})
    const before = await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")

    const { status, json } = await call(createConfigWriteHandler(dirs), {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "verbose" }, confirmed: true },
    })

    expect(status).toBe(400)
    expect(json.code).toBe("bad_request")
    expect(json.message).toContain("配置校验失败")
    expect(json.errors[0].path).toBe("log_level")
    // 校验失败必须**一个字节都不写**
    expect(await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")).toBe(before)
  })

  it("缺少 confirmed 时返回 428，且不写盘", async () => {
    const dirs = await makeConfigDirs({ "bot.yaml": "log_level: info\n" }, {})
    const before = await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")

    const { status, json } = await call(createConfigWriteHandler(dirs), {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "debug" } },
    })

    expect(status).toBe(428)
    expect(json.code).toBe("confirm_required")
    expect(await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")).toBe(before)
  })

  it("文件名过不了白名单时返回 400（路径穿越不可能通过）", async () => {
    const dirs = await makeConfigDirs({}, {})
    const handler = createConfigWriteHandler(dirs)

    for (const file of ["../package.json", "a/b.yaml", "..\\b.yaml", "bot.txt"]) {
      const { status } = await call(handler, {
        params: { name: file },
        body: { config: {}, confirmed: true },
      })
      expect(status, `${file} 应该被拒`).toBe(400)
    }
  })

  it("请求体不是对象、或 config 不是对象时返回 400", async () => {
    const dirs = await makeConfigDirs({ "bot.yaml": "log_level: info\n" }, {})
    const handler = createConfigWriteHandler(dirs)

    for (const body of [undefined, null, "x", [], { confirmed: true, config: "x" }]) {
      const { status } = await call(handler, { params: { name: "bot.yaml" }, body })
      expect(status, `body=${JSON.stringify(body)} 应该被拒`).toBe(400)
    }
  })

  it("目标文件不存在时也能写（backup 为 null），不会因为没东西备份而失败", async () => {
    const dirs = await makeConfigDirs({}, {})
    const { status, json } = await call(createConfigWriteHandler(dirs), {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "debug" }, confirmed: true },
    })

    expect(status).toBe(200)
    expect(json.backup).toBeNull()
    expect(await fs.readFile(path.join(dirs.configDir, "bot.yaml"), "utf8")).toContain("debug")
  })

  it("现有文件不是合法 YAML 时拒绝改写（先让用户修好）", async () => {
    const dirs = await makeConfigDirs({ "bot.yaml": "log_level: [未闭合\n" }, {})
    const { status, json } = await call(createConfigWriteHandler(dirs), {
      params: { name: "bot.yaml" },
      body: { config: { log_level: "debug" }, confirmed: true },
    })

    expect(status).toBe(400)
    expect(json.message).toContain("不是合法 YAML")
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
