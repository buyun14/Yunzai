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
export function createPluginsHandler({ loader } = {}) {
  return (req, res) => {
    const entries = Array.isArray(loader?.priority) ? loader.priority : []

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
      })),
    })
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
