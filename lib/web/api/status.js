import { adapters } from "../../adapter/registry.js"
import { sendJSON } from "../security.js"

/**
 * `GET /api/v1/status`：结构化状态总览。
 *
 * 对应 `docs/refactor/06-webui.md` §4。
 *
 * # 与 `#状态` 命令的关系
 *
 * 两者读的是同一批内核数据（版本、运行时长、内存、插件计数），但**不共享实现**：
 * `plugins/system/status.js` 产出的是给人看的转义文本加大量业务统计（按消息/群/用户
 * 维度的 redis 计数），而这里要的是稳定的 JSON 契约。共享会让"改消息文案"波及 API。
 * 代价是两处都要跟着内核改动走——所以这里只取**内核直接持有的**字段，不自己算业务量。
 *
 * @param {object} [deps] 依赖
 * @param {() => number|undefined} [deps.onlineOf] 取宿主在线状态
 * @param {string} [deps.version] 宿主版本号
 * @param {object} [deps.loader] 插件加载器
 * @param {() => object|undefined} [deps.hostOf] 取宿主对象
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createStatusHandler({
  onlineOf = () => undefined,
  version = "unknown",
  loader,
  hostOf = () => /** @type {any} */ (globalThis.Bot),
} = {}) {
  return (req, res) => {
    const host = hostOf() ?? {}
    const memory = process.memoryUsage()
    const uin = Array.isArray(host.uin) ? host.uin : []

    sendJSON(res, 200, {
      version,
      online: onlineOf(),
      uptime: Math.round(process.uptime()),
      memory: {
        rss: mb(memory.rss),
        heapUsed: mb(memory.heapUsed),
        heapTotal: mb(memory.heapTotal),
      },
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
      },
      plugins: {
        handlers: loader?.priority?.length ?? 0,
        loaded: pluginCountOf(loader),
        tasks: loader?.task?.length ?? 0,
      },
      adapters: adapters().map(adapter => ({ id: adapter.id, name: adapter.name })),
      // v1 只列账号，不猜在线状态：`Bot[uin].stat` 只在适配器上线后才存在，
      // 而"这个账号此刻是否连着"的可靠判据在适配器手里（各自的 capabilities）。
      accounts: uin.map(id => ({ uin: String(id) })),
    })
  }
}

/**
 * 字节 → MB（保留两位）。
 *
 * @param {number} bytes 字节数
 * @returns {number} MB
 */
function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100
}

/**
 * 插件类数量。
 *
 * 新版本把它记在 `pluginCount`；旧字段名是 `plugin_count`，
 * 这里两者都认，避免 API 因为一次改名返回 0。
 *
 * @param {object|undefined} loader 加载器
 * @returns {number} 数量
 */
function pluginCountOf(loader) {
  const count = loader?.pluginCount ?? loader?.plugin_count
  return typeof count === "number" ? count : (loader?.priority?.length ?? 0)
}
