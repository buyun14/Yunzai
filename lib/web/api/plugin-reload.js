import path from "node:path"
import { sendJSON } from "../security.js"

/**
 * `POST /api/v1/plugins/{key}/reload`：**不重启**重载一个插件的代码。
 *
 * # 复用的是内核已有的热更新路径
 *
 * `lib/plugins/loader.js` 的 `changePlugin(key)` 本来就在做这件事（文件监听热更新
 * 走的就是它），所以我们不另写一套卸载/重载逻辑——那只会与内核行为分叉。
 * 它已经处理好了三件容易做错的事：
 *
 * 1. 先 `unloadPlugin()` 摘掉 handlers 与定时任务；
 * 2. `import()` 时在路径后挂时间戳**破掉 ESM 模块缓存**（不带这个参数会拿到旧模块，
 *    表现为"重载了但行为没变"——这是热更新最经典的坑）；
 * 3. **失败要回滚**：新代码加载失败时把旧的 handlers / 任务 / 计数装回去，
 *    而不是留下一个"半死不活"的插件。
 *
 * # 为什么这条路比"重启"低风险得多
 *
 * 重启会断开所有连接、丢掉内存状态；重载只影响一个插件。所以来源闸门比
 * 重启/停止松一档：**不限制来源**（重启/停止仍然只允许本机与内网）。
 * 这个取舍是明确的：能改配置的人本来就能改插件文件，重载只是省一次重启。
 *
 * # 边界
 *
 * - `key` 必须是加载器报告过的那个（`/api/v1/plugins` 的 `key` 字段）。
 *   我们仍然做一遍**路径包含检查**：即使 key 来自请求体，也不能让它跑到
 *   插件目录外面去（`changePlugin` 会把 key 拼进 import 路径）。
 * - 只重载**一个文件**。如果插件之间有依赖（A 引用 B），B 的改动不会自动
 *   反映到已加载的 A 上——那种情况要重启。这一点如实写在响应里。
 */

/**
 * 造"重载插件"处理器。
 *
 * @param {object} [deps] 依赖
 * @param {object} [deps.loader] 插件加载器
 * @param {string} [deps.dir] 插件根目录（用于路径包含检查）
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => Promise<void>} 处理器
 */
export function createPluginReloadHandler({
  loader = /** @type {any} */ (globalThis).PluginsLoader,
  dir = "plugins",
} = {}) {
  return async (req, res, next) => {
    try {
      const key = String(req.params?.key ?? "").trim()
      if (!key) return sendJSON(res, 400, { code: "bad_request", message: "缺少插件 key" })

      // 路径包含检查。`changePlugin` 会把 key 拼进 `../../<dir>/<key>` 去 import，
      // 所以这里必须挡住 `..`、绝对路径与盘符——否则可以 import 仓库外的任意模块
      if (
        key.includes("..") ||
        path.isAbsolute(key) ||
        /^[a-zA-Z]:/.test(key) ||
        key.includes("\\")
      )
        return sendJSON(res, 400, {
          code: "bad_request",
          message: "插件 key 不合法（只接受插件目录内的相对路径）",
        })

      const known = new Set(
        (Array.isArray(loader?.priority) ? loader.priority : [])
          .map(entry => entry.key)
          .filter(Boolean),
      )
      // 只接受"加载器确实报告过"的 key：拼错一个不存在的路径会让 import 抛错，
      // 虽然 changePlugin 会兜住，但那时给它一个明确的 400 更有用
      if (!known.has(key))
        return sendJSON(res, 404, {
          code: "not_found",
          message: `没有已加载的插件对应这个 key：${key}。请用 /api/v1/plugins 里的 key 字段`,
        })

      if (typeof loader.changePlugin !== "function")
        return sendJSON(res, 503, {
          code: "unavailable",
          message: "当前加载器不支持重载",
        })

      // changePlugin 自己吞掉异常并打日志（它内部有 try/catch），
      // 所以这里只能"发起并回报已受理"——真正的结果要看加载日志
      await loader.changePlugin(key)

      // 重载后这个 key 还在不在，是判断成没成的最直接信号
      const stillLoaded = (loader.priority ?? []).some(entry => entry.key === key)

      sendJSON(res, stillLoaded ? 200 : 500, {
        key,
        reloaded: stillLoaded,
        restartRequired: false,
        note: stillLoaded
          ? "已重载该文件。若插件之间有依赖，被依赖方的改动要重启才会反映到已加载的引用方"
          : "重载后该插件不在加载列表里，多半是新代码有错——请看日志",
      })
    } catch (err) {
      next(err)
    }
  }
}
