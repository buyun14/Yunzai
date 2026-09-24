import express from "express"
import { sendJSON } from "../security.js"
import { createConfigHandler } from "./config.js"
import defaultLogStream from "./logs.js"
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
 * v1 是只读面板：所有接口都是 `GET`。写入类接口（配置编辑、插件启停、重启）
 * 属于 v2/v3，届时那些路径上要再叠一层更紧的限流与二次确认。
 *
 * | 路径 | 内容 |
 * |---|---|
 * | `GET /api/v1/ready` | 就绪探针 |
 * | `GET /api/v1/status` | 状态总览 |
 * | `GET /api/v1/plugins` | 已加载的插件（执行顺序） |
 * | `GET /api/v1/config` | 配置文件清单与差异条数 |
 * | `GET /api/v1/config/schemas` | 宿主配置的 schema（v2 表单用）与明确不建模的文件 |
 * | `GET /api/v1/config/{name}` | 单个文件两侧的值（已脱敏） |
 * | `GET /api/v1/logs` | SSE 实时日志流 |
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
  router.get("/config", createConfigHandler())
  // ⚠️ 必须排在 `/config/:name` **之前**：否则 `schemas` 会被当成一个文件名
  // 匹配进 `:name`，然后被文件名白名单拒成 400。
  router.get("/config/schemas", createSchemasHandler())
  // 单文件用路径参数而不是 `?file=`：契约里“同一个路径两种形状”对生成客户端
  // 只能表达成 oneOf，而前端要的就是确切类型。文件名白名单在处理器里校验。
  router.get("/config/:name", createConfigHandler())
  // SSE：不断开、不结束响应。断开时的清理在 createHandler 里（靠 req/res 的 close）
  router.get("/logs", logStream.createHandler())

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
