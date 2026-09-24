import express from "express"
import { sendJSON } from "../security.js"
import { createConfigHandler } from "./config.js"
import { createConfigWriteHandler } from "./config-write.js"
import {
  createControlCapabilitiesHandler,
  createLocalOnlyGate,
  createRestartHandler,
  createStopHandler,
} from "./control.js"
import defaultLogStream from "./logs.js"
import { createPluginReloadHandler } from "./plugin-reload.js"
import { createPluginToggleHandler } from "./plugin-toggle.js"
import { createPluginsHandler } from "./plugins.js"
import { createSchemasHandler } from "./schemas.js"
import { createStatusHandler } from "./status.js"

/**
 * 就绪探针。前端的等待页只依赖这一个接口。
 *
 * 注意**启动期这个请求到不了这里**：那时它由 WebUI 的早期探针（挂在 `serverAuth` 之前）
 * 就地答复 503；能走到本处理器就说明宿主已上线。
 *
 * 抽成工厂是为了让契约一致性测试能直接取样，而不是从路由表里挖 handler。
 *
 * @param {{ onlineOf?: () => number|undefined }} [deps] 依赖
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createReadyHandler({ onlineOf } = {}) {
  return (req, res) =>
    sendJSON(res, 200, { ready: true, online: onlineOf?.(), uptime: Math.round(process.uptime()) })
}

/**
 * `/api/v1` 的路由汇总。
 *
 * 对应 `docs/refactor/06-webui.md` §4。这里是**唯一**登记路径的地方——
 * 契约（`docs/openapi.yaml`）与它就应当一一对应。
 *
 * v1 是只读面板（四个 `GET`）；v2 起有写入，目前**只有一个**：配置写入。
 * 插件启停、重启之类的敏感操作仍在后面，落地时要在对应子路径上再叠一层
 * 更紧的限流与二次确认（见 `06-webui.md` §5 那条未勾选的验收项）。
 *
 * v3 起有**进程控制**（重启/停止）：它们比配置写入更危险——能把服务停掉，
 * 而停止不会自己回来。因此额外加了一条 `createLocalOnlyGate()`：
 * 只允许本机与内网来源，公网来源一律 403（理由见 `control.js` 的模块头）。
 *
 * | 路径 | 内容 |
 * |---|---|
 * | `GET /api/v1/ready` | 就绪探针 |
 * | `GET /api/v1/status` | 状态总览 |
 * | `GET /api/v1/plugins` | 已加载的插件（执行顺序） |
 * | `GET /api/v1/config` | 配置文件清单与差异条数 |
 * | `GET /api/v1/config/schemas` | 宿主配置的 schema（v2 表单用）与明确不建模的文件 |
 * | `GET /api/v1/config/{name}` | 单个文件两侧的值（已脱敏） |
 * | `PUT /api/v1/config/{name}` | 写入单个文件（原子写 + 写前备份 + 校验；**唯一**的写接口） |
 * | `GET /api/v1/logs` | SSE 实时日志流 |
 * | `GET /api/v1/control` | 这个部署能不能远程做进程控制（界面据此决定是否显示按钮） |
 * | `POST /api/v1/control/restart` | 重启（**仅本机/内网**） |
 * | `POST /api/v1/control/stop` | 停止（**仅本机/内网**，且不会自动恢复） |
 *
 * **只有读接口需要与 `docs/openapi.yaml` 的响应体逐字段对齐**；
 * 写接口的响应体同样登记在契约里，检查方式一样。
 *
 * **这张表与 `docs/openapi.yaml` 必须一一对应**——`tests/unit/web/openapi.test.js`
 * 会对着真实路由与真实响应体做一致性检查，改接口时两边都要动。
 *
 * @param {object} [deps] 依赖
 * @param {() => number|undefined} [deps.onlineOf] 取宿主在线状态
 * @param {() => object|undefined} [deps.hostOf] 取宿主对象
 * @param {object} [deps.loader] 插件加载器（`lib/bot.js` 在挂载时传入）
 * @param {string} [deps.version] 宿主版本号
 * @param {import("./logs.js").LogStream} [deps.logStream] 日志流
 * @returns {import("express").Router} 路由器
 */
export function createApiRouter({
  onlineOf,
  hostOf,
  loader,
  version,
  logStream = defaultLogStream,
} = {}) {
  const router = express.Router()

  router.get("/ready", createReadyHandler({ onlineOf }))

  router.get("/status", createStatusHandler({ onlineOf, hostOf, loader, version }))
  router.get("/plugins", createPluginsHandler({ loader }))
  // 插件启停（v3）。写的是 `group.yaml` 的 `default.disable`，写完立刻生效
  // （不需要重启）——机制与边界见 lib/web/api/plugin-toggle.js 的模块头。
  router.put("/plugins/:name", createPluginToggleHandler())
  // 不重启重载一个插件的代码（v3）。复用的是内核的热更新路径 `changePlugin()`，
  // 它已经处理好"破 ESM 缓存"与"失败回滚"两件容易做错的事。
  // 路径参数名与上面那条保持一致（`:key` 会让 express 5 抛
  // `Cannot use two different param names at the same position`）
  router.post("/plugins/:key/reload", createPluginReloadHandler({ loader }))
  router.get("/config", createConfigHandler())
  // ⚠️ 必须排在 `/config/:name` **之前**：否则 `schemas` 会被当成一个文件名
  // 匹配进 `:name`，然后被文件名白名单拒成 400。
  router.get("/config/schemas", createSchemasHandler())
  // 单文件用路径参数而不是 `?file=`：契约里“同一个路径两种形状”对生成客户端
  // 只能表达成 oneOf，而前端要的就是确切类型。文件名白名单在处理器里校验。
  router.get("/config/:name", createConfigHandler())
  // 写入（v2）。四道闸门与原子写见 lib/web/api/config-write.js 的模块头。
  // 与 GET 同路径、不同方法：一个是"看这个文件"，一个是"改这个文件"。
  router.put("/config/:name", createConfigWriteHandler())
  // SSE：不断开、不结束响应。断开时的清理在 createHandler 里（靠 req/res 的 close）
  router.get("/logs", logStream.createHandler())
  // 首页摘要用的一次性快照。**必须在 `/logs` 之后**：`/logs` 是精确路径，
  // 两者不会互相截胡，但把更具体的放前面是这一层路由的既定顺序
  router.get("/logs/recent", logStream.createRecentHandler())

  // 进程控制（v3）。**只允许本机与内网来源**——它们能把服务停掉，
  // 而停止不会自己回来。闸门在这里统一挂，别让每个处理器各自记得检查。
  router.get("/control", createControlCapabilitiesHandler())
  router.post("/control/restart", createLocalOnlyGate(), createRestartHandler({ hostOf }))
  router.post("/control/stop", createLocalOnlyGate(), createStopHandler({ hostOf }))

  // 未命中的 API 一律返回 JSON 404。
  // 不能让它落到宿主的兜底处理——那里从前会把请求 302 到 `server.redirect`，
  // 对 API 客户端来说"一个 HTML 跳转"比 404 难排查得多。
  // （`server.redirect` 与其跳转行为已按 BCR-0003 删除，宿主的兜底现在同样是 404 JSON；
  //  这条仍然保留着，是为了让 API 的 404 形状由本模块自己保证，不依赖宿主的实现。）
  router.use((req, res) =>
    sendJSON(res, 404, {
      code: "not_found",
      message: `未知接口 ${req.method} ${req.originalUrl}`,
    }),
  )

  return router
}
