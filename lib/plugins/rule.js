/**
 * 插件 `rule` / `handler` 的归一化与校验。
 *
 * 对应文档：docs/refactor/01-plugin-contract.md §3.3
 *
 * ⚠️ **本模块必须保持行为等价于改造前 `lib/plugins/loader.js` 中的内联实现。**
 * 它做的是"把内联逻辑搬到一个有名字的地方，并补上校验告警"，
 * 任何语义变化都必须在 01-plugin-contract.md 中登记，而不是顺手改掉。
 */

/** `rule.permission` 的已知取值（来自 `lib/plugins/loader.js` 的 `filtPermission`） */
export const PERMISSION_VALUES = ["all", "admin", "owner", "master"]

/**
 * 归一化一个插件实例的命令规则。
 *
 * 会**就地修改** `instance.rule[i].reg`（与改造前一致），把字符串正则编译为 `RegExp`。
 *
 * @param {{ rule?: unknown, handler?: unknown, name?: string }} instance 插件实例
 * @returns {{ rules: Array<Record<string, unknown>>, warnings: string[] }}
 */
export function normalizeRules(instance) {
  /** @type {string[]} */
  const warnings = []
  const label = instance?.name ? `[${instance.name}]` : ""

  if (instance?.rule === undefined) return { rules: [], warnings }

  if (!Array.isArray(instance.rule)) {
    warnings.push(`${label} rule 期望数组，实际是 ${typeof instance.rule}，已忽略`)
    return { rules: [], warnings }
  }

  /** @type {Array<Record<string, unknown>>} */
  const rules = []
  for (const [index, raw] of instance.rule.entries()) {
    if (raw === null || typeof raw !== "object") {
      warnings.push(`${label} rule[${index}] 期望对象，已忽略`)
      continue
    }

    const rule = /** @type {Record<string, unknown>} */ (raw)

    // 与改造前一致：非 RegExp 一律交给 new RegExp()。
    // 注意 `new RegExp(undefined)` 会得到 `/(?:)/`（匹配任何输入），
    // 这让"只按 rule.event 匹配、不写 reg"的用法得以工作，因此不能收紧。
    if (!(rule.reg instanceof RegExp)) {
      const source = rule.reg
      try {
        rule.reg = new RegExp(/** @type {string|RegExp} */ (source))
      } catch (err) {
        warnings.push(`${label} rule[${index}].reg 不是合法正则：${err.message}`)
      }
      if (source === undefined)
        warnings.push(
          `${label} rule[${index}] 没有 reg，编译为匹配任意输入的 /(?:)/（若只想按 event 匹配请显式写 event）`,
        )
    }

    if (rule.fnc === undefined) warnings.push(`${label} rule[${index}] 缺少 fnc，永远不会被执行`)
    else if (typeof instance[/** @type {string} */ (rule.fnc)] !== "function")
      warnings.push(`${label} rule[${index}].fnc「${String(rule.fnc)}」不是插件实例上的方法`)

    if (
      rule.permission !== undefined &&
      !PERMISSION_VALUES.includes(/** @type {string} */ (rule.permission))
    )
      warnings.push(
        `${label} rule[${index}].permission「${String(rule.permission)}」不是已知取值（${PERMISSION_VALUES.join(" / ")}）。` +
          `当前实现会把未知取值视为"放行"，阶段 2 将改为默认拒绝`,
      )

    rules.push(rule)
  }

  return { rules, warnings }
}

/**
 * 校验插件实例的 `handler` 声明（只告警，不改行为）。
 *
 * @param {{ handler?: unknown, name?: string }} instance 插件实例
 * @returns {string[]} 告警列表
 */
export function checkHandlers(instance) {
  /** @type {string[]} */
  const warnings = []
  const label = instance?.name ? `[${instance.name}]` : ""
  if (instance?.handler === undefined) return warnings

  if (instance.handler === null || typeof instance.handler !== "object") {
    warnings.push(`${label} handler 期望对象，实际是 ${typeof instance.handler}，已忽略`)
    return warnings
  }

  for (const [key, raw] of Object.entries(instance.handler)) {
    if (raw === null || typeof raw !== "object") {
      warnings.push(`${label} handler.${key} 期望对象，已忽略`)
      continue
    }
    const { fn } = /** @type {Record<string, unknown>} */ (raw)
    if (fn === undefined) warnings.push(`${label} handler.${key} 缺少 fn`)
    else if (typeof instance[/** @type {string} */ (fn)] !== "function")
      warnings.push(`${label} handler.${key}.fn「${String(fn)}」不是插件实例上的方法`)
  }

  return warnings
}
