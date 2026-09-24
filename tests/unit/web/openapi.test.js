import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import YAML from "yaml"
import { createConfigHandler } from "../../../lib/web/api/config.js"
import { createConfigWriteHandler } from "../../../lib/web/api/config-write.js"
import {
  createControlCapabilitiesHandler,
  createRestartHandler,
} from "../../../lib/web/api/control.js"
import { createPluginsHandler } from "../../../lib/web/api/plugins.js"
import { createApiRouter, createReadyHandler } from "../../../lib/web/api/router.js"
import { createSchemasHandler } from "../../../lib/web/api/schemas.js"
import { createStatusHandler } from "../../../lib/web/api/status.js"

/**
 * 契约与实现的一致性检查（对应 `docs/refactor/06-webui.md` §3.2）。
 *
 * # 为什么不是「生成客户端后 `git diff --exit-code`」
 *
 * 分册原本写的是那个方案（借鉴 AstrBot）。它防的是**契约与生成物**漂移，
 * 却防不住真正的风险：**契约与服务器漂移**。而且它需要引入
 * `@hey-api/openapi-ts` 这个 devDep，而它的唯一产物（`dashboard/src/api/generated/`）
 * 在前端还不存在时无处可放。
 *
 * 于是这里换成更直接的检查：解析契约文件，逐项对着**真实路由**与**真实响应体**比。
 * 前端落地之后可以把「生成 + diff」叠加上来，两者互补（一个守契约↔服务器，
 * 一个守契约↔客户端）。
 */

const SPEC_FILE = new URL("../../../docs/openapi.yaml", import.meta.url)

/** 临时配置目录（给 `/api/v1/config/{name}` 的取样用），跑完删掉 */
let configDirs

/** 写入接口专用的临时目录：PUT 会真的改文件，不能和只读取样共用 */
let writeDirs

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-openapi-"))
  configDirs = { configDir: path.join(root, "config"), defaultsDir: path.join(root, "defaults") }
  await fs.mkdir(configDirs.configDir, { recursive: true })
  await fs.mkdir(configDirs.defaultsDir, { recursive: true })
  await fs.writeFile(path.join(configDirs.configDir, "bot.yaml"), "log_level: info\n", "utf8")
  await fs.writeFile(path.join(configDirs.defaultsDir, "bot.yaml"), "log_level: info\n", "utf8")

  const writeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "yz-openapi-write-"))
  writeDirs = {
    configDir: path.join(writeRoot, "config"),
    backupDir: path.join(writeRoot, "backups"),
  }
  await fs.mkdir(writeDirs.configDir, { recursive: true })
  await fs.writeFile(path.join(writeDirs.configDir, "bot.yaml"), "log_level: info\n", "utf8")
})

afterAll(async () => {
  for (const dir of [configDirs?.configDir, writeDirs?.configDir])
    if (dir) await fs.rm(path.dirname(dir), { recursive: true, force: true })
})

/** 读契约文件 */
async function readSpec() {
  return YAML.parse(await fs.readFile(SPEC_FILE, "utf8"))
}

/**
 * 列出路由器上真正注册的 `路径 → 方法`。
 *
 * 同一个路径可以注册多个方法（`/config/:name` 就是 GET + PUT），
 * 所以这里要把同路径的多个 layer **合并**而不是让后者覆盖前者——
 * 覆盖掉的话契约里写了两个方法就会与路由"看起来不一致"，
 * 而真正的问题（漏了一个方法）反而被掩盖。
 *
 * @param {import("express").Router} router 路由器
 * @returns {Record<string, string[]>} 路径 → 小写方法名
 */
function routesOf(router) {
  /** @type {Record<string, string[]>} */
  const routes = {}
  for (const layer of router.stack) {
    if (!layer.route) continue
    const methods = Object.keys(layer.route.methods).map(method => method.toLowerCase())
    routes[layer.route.path] = [
      ...new Set([...(routes[layer.route.path] ?? []), ...methods]),
    ].sort()
  }
  return routes
}

/**
 * 契约里声明的 `路径 → 方法`。
 *
 * @param {Record<string, any>} spec 契约
 * @returns {Record<string, string[]>} 路径 → 小写方法名
 */
function pathsOf(spec) {
  /** @type {Record<string, string[]>} */
  const routes = {}
  for (const [routePath, item] of Object.entries(spec.paths))
    routes[routePath] = Object.keys(item)
      .filter(key => ["get", "post", "put", "patch", "delete"].includes(key))
      .map(method => method.toLowerCase())
      .sort()
  return routes
}

/**
 * 造一个可链式调用的最小响应对象。
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
 * 调一次处理器，返回解析后的 JSON。
 *
 * @param {Function} handler 处理器
 * @param {Record<string, unknown>} req 请求替身
 * @returns {Promise<any>} 响应体
 */
async function bodyOf(handler, req = { params: {}, query: {} }) {
  const res = resOf()
  await handler(req, res, err => {
    throw err
  })
  return JSON.parse(String(res.body ?? "null"))
}

/**
 * 每个**有 JSON 响应体**的接口 → 取样函数。
 *
 * `/logs` 不在这里：它是 SSE，形状由事件帧决定，由 `logs.test.js` 覆盖。
 *
 * @returns {Record<string, () => Promise<any>>} 接口 → 取样函数
 */
function samplers() {
  return {
    "/api/v1/ready": () => bodyOf(createReadyHandler({ onlineOf: () => 2 })),
    "/api/v1/status": () =>
      bodyOf(
        createStatusHandler({
          onlineOf: () => 2,
          version: "9.9.9",
          loader: { priority: [{}], pluginCount: 1, task: [] },
          hostOf: () => ({ uin: [12345] }),
        }),
      ),
    "/api/v1/plugins": () =>
      bodyOf(
        createPluginsHandler({
          loader: {
            priority: [
              {
                name: "甲",
                namespace: "ns",
                key: "k",
                priority: 100,
                plugin: { dsc: "说明", event: "message", rule: [{ reg: /^#x/, fnc: "f" }] },
              },
            ],
          },
        }),
      ),
    "/api/v1/config": () => bodyOf(createConfigHandler(configDirs)),
    "/api/v1/config/schemas": () => bodyOf(createSchemasHandler()),
    "/api/v1/config/{name}": () =>
      bodyOf(createConfigHandler(configDirs), { params: { name: "bot.yaml" }, query: {} }),
    // 写入接口。带 `#put` 后缀是为了与上面那条同路径的 GET 区分开——
    // `Object.entries` 的键必须唯一，而这两者的响应体 schema 不同。
    "/api/v1/config/{name}#put": () =>
      bodyOf(createConfigWriteHandler(writeDirs), {
        params: { name: "bot.yaml" },
        query: {},
        body: { config: { log_level: "info" }, confirmed: true },
      }),
    // 控制接口。来源必须是内网地址，否则 `canControl` 为 false
    "/api/v1/control": () =>
      bodyOf(createControlCapabilitiesHandler(), {
        params: {},
        query: {},
        socket: { remoteAddress: "127.0.0.1" },
      }),
    // 用很长的 delay：这一步只取样响应体，**不能真的重启测试进程**
    "/api/v1/control/restart#post": () =>
      bodyOf(createRestartHandler({ hostOf: () => ({}), delay: 60_000 }), {
        params: {},
        query: {},
        socket: { remoteAddress: "127.0.0.1" },
      }),
  }
}

describe("openapi.yaml 的结构", () => {
  it("是 3.x 且带 info / servers / paths", async () => {
    const spec = await readSpec()
    expect(String(spec.openapi)).toMatch(/^3\./)
    expect(spec.info.title).toBeTruthy()
    expect(spec.info.version).toBeTruthy()
    expect(spec.info.description).toContain("server.webui.enable")
    expect(spec.servers.length).toBeGreaterThan(0)
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0)
  })

  it("每个接口的每个响应都有 summary / operationId / responses / description", async () => {
    const spec = await readSpec()
    for (const [routePath, item] of Object.entries(spec.paths))
      for (const [method, operation] of Object.entries(item)) {
        expect(operation.summary, `${routePath} ${method} 缺 summary`).toBeTruthy()
        expect(operation.operationId, `${routePath} ${method} 缺 operationId`).toBeTruthy()
        expect(
          Object.keys(operation.responses ?? {}).length,
          `${routePath} 缺 responses`,
        ).toBeGreaterThan(0)

        for (const [status, response] of Object.entries(operation.responses)) {
          // `#/components/responses/Xxx` 的第一段（`#`）不是键，要跳过
          const resolved = response.$ref
            ? response.$ref
                .split("/")
                .slice(1)
                .reduce((node, key) => node?.[key], spec)
            : response
          expect(
            resolved?.description,
            `${routePath} ${method} 的 ${status} 缺 description`,
          ).toBeTruthy()
        }
      }
  })

  it("错误响应统一是 { code, message }，而 401 明确写了它是纯文本", async () => {
    const spec = await readSpec()
    expect(spec.components.schemas.Error.required).toEqual(["code", "message"])
    // 401 来自宿主的 serverAuth，返回的不是 JSON。注释里不写清，实现方就会写错
    expect(spec.components.responses.Unauthorized.description).toContain("纯文本")
  })
})

describe("契约与路由一致", () => {
  it("路由器上注册的路径与方法就是预期的这些", () => {
    expect(routesOf(createApiRouter())).toEqual({
      "/ready": ["get"],
      "/status": ["get"],
      "/plugins": ["get"],
      "/config": ["get"],
      // ⚠️ 顺序有意义：`/config/schemas` 必须排在 `/config/:name` 之前，
      // 否则 `schemas` 会被当成文件名匹配进 `:name`（实证见 06-webui.md §4）。
      // 这里断言的是**集合**，顺序由 `server.test.js` 里那条真实 HTTP 用例守着
      "/config/schemas": ["get"],
      // 同路径两个方法：GET 读、PUT 写
      "/config/:name": ["get", "put"],
      "/logs": ["get"],
      // 进程控制（v3）。`/control` 是能力探测，两个动作是 POST
      "/control": ["get"],
      "/control/restart": ["post"],
      "/control/stop": ["post"],
    })
  })

  it("契约里的路径与路由一一对应（`{name}` ↔ `:name`），数量也相等", async () => {
    const spec = await readSpec()
    const routes = routesOf(createApiRouter())
    const declared = pathsOf(spec)

    for (const [routePath, methods] of Object.entries(declared)) {
      const expressPath = routePath.replace(/^\/api\/v1/, "").replace(/\{(\w+)\}/g, ":$1")
      expect(routes[expressPath], `契约声明了 ${routePath}，路由里却没有`).toEqual(methods)
    }
    expect(Object.keys(declared).length).toBe(Object.keys(routes).length)
  })
})

describe("契约与响应体一致", () => {
  it("200 响应的顶层字段与真实返回的字段完全一致", async () => {
    const spec = await readSpec()

    for (const [routePath, sample] of Object.entries(samplers())) {
      // `#put` 的取样归 PUT 那条用例管（响应体 schema 不同）
      if (routePath.includes("#")) continue
      const schema = spec.paths[routePath].get.responses["200"].content["application/json"].schema
      const properties = spec.components.schemas[schema.$ref.split("/").pop()].properties
      const body = await sample()

      // 双向比较：契约写了却没返回（谎言）、返回了但契约没写（漏文档）都算不一致。
      // 这就是"加了一个字段忘了改契约"的哨兵——它比"生成物与契约一致"更贴近真正的风险
      expect(Object.keys(body).sort(), `${routePath} 的字段与契约不一致`).toEqual(
        Object.keys(properties).sort(),
      )
    }
  })

  it("写入接口（PUT）的 200 响应体与 ConfigWriteResult 一致", async () => {
    const spec = await readSpec()
    const schema =
      spec.paths["/api/v1/config/{name}"].put.responses["200"].content["application/json"].schema
    expect(schema.$ref).toBe("#/components/schemas/ConfigWriteResult")

    const body = await samplers()["/api/v1/config/{name}#put"]()
    const properties = spec.components.schemas.ConfigWriteResult.properties
    expect(Object.keys(body).sort()).toEqual(Object.keys(properties).sort())
  })

  it("控制接口的响应体与契约一致（能力是 200、动作是 202）", async () => {
    const spec = await readSpec()
    const sample = samplers()

    // GET /control → 200 ControlCapabilities
    const capabilitiesBody = await sample["/api/v1/control"]()
    const capabilitiesRef =
      spec.paths["/api/v1/control"].get.responses["200"].content["application/json"].schema.$ref
    expect(capabilitiesRef).toBe("#/components/schemas/ControlCapabilities")
    expect(Object.keys(capabilitiesBody).sort()).toEqual(
      Object.keys(spec.components.schemas.ControlCapabilities.properties).sort(),
    )

    // POST /control/restart → **202**（不是 200）：进程随后就退出、连接会断，
    // 所以后端先把"已受理"发出来
    const acceptedBody = await sample["/api/v1/control/restart#post"]()
    const acceptedRef =
      spec.paths["/api/v1/control/restart"].post.responses["202"].content["application/json"].schema
        .$ref
    expect(acceptedRef).toBe("#/components/schemas/ControlAccepted")
    expect(Object.keys(acceptedBody).sort()).toEqual(
      Object.keys(spec.components.schemas.ControlAccepted.properties).sort(),
    )
  })

  it("嵌套对象同样逐字段核对", async () => {
    const spec = await readSpec()
    const schemas = spec.components.schemas
    const bodies = {}
    for (const [routePath, sample] of Object.entries(samplers())) bodies[routePath] = await sample()

    /**
     * @param {Record<string, unknown>} actual 实际对象
     * @param {string} name 契约里的 schema 名
     * @param {string} label 报错时用的位置
     */
    const sameKeys = (actual, name, label) =>
      expect(Object.keys(actual).sort(), `${label} 与 ${name} 不一致`).toEqual(
        Object.keys(schemas[name].properties).sort(),
      )

    const status = bodies["/api/v1/status"]
    sameKeys(status.memory, "StatusMemory", "status.memory")
    sameKeys(status.runtime, "StatusRuntime", "status.runtime")
    sameKeys(status.plugins, "StatusPlugins", "status.plugins")

    const plugin = bodies["/api/v1/plugins"].plugins[0]
    sameKeys(plugin, "Plugin", "plugins[0]")
    sameKeys(plugin.rules[0], "PluginRule", "plugins[0].rules[0]")

    const list = bodies["/api/v1/config"]
    sameKeys(list.summary, "ConfigDiffSummary", "config.summary")
    expect(Object.keys(list.dirs).sort()).toEqual(["config", "defaults"])
    expect(Object.keys(list.files[0]).sort()).toEqual(["differences", "name", "status"])
  })

  it("枚举值写进契约的值域（status 只能是那三种）", async () => {
    const spec = await readSpec()
    const statuses =
      spec.components.schemas.ConfigList.properties.files.items.properties.status.enum

    const bodies = {}
    for (const [routePath, sample] of Object.entries(samplers())) bodies[routePath] = await sample()

    expect(statuses).toEqual(["both", "only-user", "only-default"])
    expect(statuses).toContain(bodies["/api/v1/config"].files[0].status)
    expect(statuses).toContain(bodies["/api/v1/config/{name}"].status)
  })
})
