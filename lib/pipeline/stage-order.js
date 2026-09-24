import { registeredStages } from "./stage.js"

/**
 * 阶段执行顺序。
 *
 * 对应文档：docs/refactor/02-pipeline.md §3
 *
 * ## 顺序不是随手排的
 *
 * 这份列表逐项对应改造前 `lib/plugins/loader.js` 里 `deal()` 的步骤（该函数已随
 * 阶段 2 第 5 步删除，对照表见文档 §2），
 * 并且刻意保留了那里的**三处位置敏感关系**（见文档 §2.2）：
 *
 * 1. `RateLimitCheckStage` 必须早于 `NormalizeStage`
 *    ——前者读 `e.isPrivate`，而该字段只在后者中赋值；私聊消息在此时
 *    `e.isPrivate === undefined`，因此不会走 `checkLimit` 的早退分支，而是继续走到
 *    `msgThrottle` 去重。把归一化提前会**静默改变私聊的限流行为**。
 * 2. `RateLimitCommitStage` 必须紧接在 `NormalizeStage` 之后、`ProcessStage` 之前
 *    ——它依赖归一化算出的 `e.only_reply_at`，又必须在插件执行前生效，
 *    否则插件里一段耗时数秒的渲染会让群内其他消息在这段时间内不被冷却拦截。
 * 3. `WakeupGateStage` 里的唤醒门槛必须排在 context hook **之后**
 *    ——原代码如此；提前会让 `getContext()` 钩子在不该运行的场景下少跑一次。
 *
 * 改动这份列表等同于改动消息处理语义，必须同步更新文档与回归用例。
 */
export const STAGES_ORDER = [
  "StatisticsStage", // 1  接收统计（整条流水线的耗时由 EventBus 在 execute 外测）
  "WhitelistCheckStage", // 2  用户/群黑白名单
  "ProfileResolveStage", // 3  解析群配置
  "RateLimitCheckStage", // 4  禁言 + 群冷却 + 单人冷却 + 同文去重
  "NormalizeStage", // 5  事件归一化（拼 msg/img/atBot/… 与 only_reply_at）
  "RateLimitCommitStage", // 6  提交冷却
  "PreProcessStage", // 7  包装 e.reply + 注册 runtime
  "WakeupGateStage", // 8  插件筛选 + context hook + 唤醒门槛
  "ProcessStage", // 9  命令前缀归一化 + accept + rule 匹配（终止段）
]

/**
 * 校验注册表与 `STAGES_ORDER` 严格一一对应。
 *
 * 多一个、少一个都抛错。允许"多"会让新增阶段可以绕过顺序声明，
 * 从而得到不确定的执行顺序——那正是这套机制要消灭的问题。
 *
 * @param {Array<new () => { constructor: { name: string } }>} [stages] 待校验的阶段类列表，
 *   缺省使用全局注册表
 * @returns {void}
 */
export function assertStageCoverage(stages) {
  const list = stages ?? registeredStages
  const registered = list.map(stage => stage.name)

  const duplicated = registered.filter((name, index) => registered.indexOf(name) !== index)
  const missing = STAGES_ORDER.filter(name => !registered.includes(name))
  const extra = registered.filter(name => !STAGES_ORDER.includes(name))

  if (duplicated.length) throw new Error(`阶段被重复注册：${dedupe(duplicated).join("、")}`)

  if (missing.length || extra.length) {
    const lines = ["阶段注册表与 STAGES_ORDER 不一致："]
    if (missing.length) lines.push(`  缺少注册：${missing.join("、")}`)
    if (extra.length) lines.push(`  STAGES_ORDER 未声明：${extra.join("、")}`)
    lines.push("  新增阶段必须同时在 lib/pipeline/stage-order.js 的 STAGES_ORDER 中定位")
    throw new Error(lines.join("\n"))
  }
}

/**
 * 去重。
 * @param {string[]} list 原数组
 * @returns {string[]} 去重后的数组
 */
function dedupe(list) {
  return [...new Set(list)]
}
