import express from "express"
import { sendJSON } from "../security.js"
import { createConfigHandler } from "./config.js"
import defaultLogStream from "./logs.js"
import { createPluginsHandler } from "./plugins.js"
import { createStatusHandler } from "./status.js"

/**
 * `/api/v1` 的路由汇总。
 *
 * 对应 `docs/refactor/06-webui.md` §4。这里是**唯一**登记路径的地方——
 * 契约（`docs/openapi.yaml`）与它就应当一一对应。
 *
 * v1 是只读面板：所有接口都是 `GET`。写入类接口（配置编辑、插件启停、重启）
 * 属于 v2/v3，届时那些路径上要再叠一层更紧的限流与二次确认。
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

  /**
   * 就绪探针。前端的等待页只依赖这一个接口：
   * 启动期它其实由 WebUI 的早期探针答复 503（那时请求根本到不了这里），
   * 走到这里就说明宿主已经上线。
   */
  router.get("/ready", (req, res) =>
    sendJSON(res, 200, { ready: true, online: onlineOf?.(), uptime: Math.round(process.uptime()) }),
  )

  router.get("/status", createStatusHandler({ onlineOf, hostOf, loader, version }))
  router.get("/plugins", createPluginsHandler({ loader }))
  router.get("/config", createConfigHandler())
  // SSE：不断开、不结束响应。断开时的清理在 createHandler 里（靠 req/res 的 close）
  router.get("/logs", logStream.createHandler())

  // 未命中的 API 一律返回 JSON 404。
  // 不能让它落到宿主的兜底处理——那里会把请求 302 到 server.redirect，
  // 对 API 客户端来说"一个 HTML 跳转"比 404 更难排查。
  router.use((req, res) =>
    sendJSON(res, 404, {
      code: "not_found",
      message: `未知接口 ${req.method} ${req.originalUrl}`,
    }),
  )

  return router
}
