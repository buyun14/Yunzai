import cfg from "../../config/config.js"
import { sendJSON } from "../security.js"

/**
 * `GET /api/v1/plugins`：当前已加载的插件声明。
 *
 * 对应 `docs/refactor/06-webui.md` §4。
 *
 * # 数据来源是内存里的 `priority`，不是磁盘上的 `plugin.json`
 *
 * 面板要回答的是"**现在生效的是哪些**"，所以读加载器已经排好序的 `priority`
 * （阶段 2 起它就是唯一的调度来源）。磁盘元数据（`plugin.json`）只是加载时的输入，
 * 插件被 `disable` 掉之后它仍然在磁盘上——用磁盘数据做展示会出现
 * "面板里有、实际不工作"的错觉。
 *
 * 顺序原样保留：它就是规则的**执行顺序**（按 `priority` 升序），是排查
 * "为什么这个插件先抢到消息"的第一手材料。
 *
 * @param {object} [deps] 依赖
 * @param {object} [deps.loader] 插件加载器
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
/**
 * 造插件列表处理器。
 *
 * @param {object} [deps] 依赖
 * @param {object} [deps.loader] 插件加载器（取 `priority`）
 * @param {object} [deps.cfgRef] 配置单例（读全局停用名单；测试可注入）
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createPluginsHandler({ loader, cfgRef = cfg } = {}) {
  return (req, res) => {
    const entries = Array.isArray(loader?.priority) ? loader.priority : []
    // 全局停用名单（`group.yaml` 的 `default.disable`）。界面据此标出"已停用"，
    // 以及决定那个开关该显示开还是关
    const disabled = new Set(globalDisableList(cfgRef))

    sendJSON(res, 200, {
      total: entries.length,
      plugins: entries.map(entry => ({
        name: entry.name ?? null,
        namespace: entry.namespace ?? null,
        key: entry.key ?? null,
        priority: entry.priority ?? null,
        description: entry.plugin?.dsc ?? null,
        events: toArray(entry.plugin?.event),
        rules: ruleList(entry.plugin?.rule),
        // ⚠️ 停用是**按插件名**匹配的（`loader.js` 用 `groupCfg.disable.includes(p.name)`），
        // 所以名字为 null 的条目无法表达"启停"，界面上要禁用那个开关
        enabled: entry.name ? !disabled.has(entry.name) : null,
      })),
    })
  }
}

/**
 * 取全局停用名单。
 *
 * 读不到就返回空数组：`group.yaml` 缺失或用户手改坏了都不该让插件列表接口失败
 * ——"面板看不到插件"比"某个开关默认显示成开"严重得多。
 *
 * @param {object} cfgRef 配置单例
 * @returns {string[]} 停用的插件名
 */
function globalDisableList(cfgRef) {
  try {
    const list = cfgRef?.getGroup?.("", "")?.disable
    return Array.isArray(list) ? list.map(item => String(item)) : []
  } catch {
    return []
  }
}

/**
 * 统一成数组。插件声明里 `event` 既可以是字符串也可以是数组。
 *
 * @param {unknown} value 原值
 * @returns {string[]} 数组
 */
function toArray(value) {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]).map(item => String(item))
}

/**
 * 规则摘要。
 *
 * 只暴露面板需要的四个字段，不把整个规则对象抛出去：
 * 里面既有 `RegExp` 实例也有处理方法名，序列化出来是 `{}`，对客户端毫无意义。
 *
 * @param {unknown} rules 插件声明的 `rule`
 * @returns {Array<{ reg: string, fnc: string|null, permission: string|null, log: boolean|null }>} 摘要
 */
function ruleList(rules) {
  if (!Array.isArray(rules)) return []
  return rules.map(rule => ({
    reg: rule?.reg instanceof RegExp ? rule.reg.source : String(rule?.reg ?? ""),
    fnc: rule?.fnc ?? null,
    permission: rule?.permission ?? null,
    log: typeof rule?.log === "boolean" ? rule.log : null,
  }))
}
