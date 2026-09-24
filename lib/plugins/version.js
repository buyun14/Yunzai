import semver from "semver"

/**
 * 插件对宿主版本的要求校验。
 *
 * 与 AstrBot 的 `astrbot_version` 字段对应（见 docs/refactor/01-plugin-contract.md §3.1）。
 * AstrBot 用 PEP 440 specifier，这里用 semver range。
 */

/**
 * 判断一个字符串是否是作者**显式声明**的合法 semver range。
 *
 * 注意与 `semver.validRange()` 的差异：后者把空串当作通配 `*` 并返回有效，
 * 而"空串"在本模块的语义里是"没有声明范围"，因此这里显式排除空串。
 *
 * @param {unknown} range 待检查的范围
 * @returns {boolean}
 */
export function isValidRange(range) {
  if (typeof range !== "string" || range.trim() === "") return false
  return semver.validRange(range) !== null
}

/**
 * 校验宿主版本是否满足插件声明的范围。
 *
 * 三种结果：
 * - `{ ok: true }`：满足，或插件未声明范围；
 * - `{ ok: false, invalid: true, reason }`：插件声明的范围本身不合法（插件作者的错误）；
 * - `{ ok: false, reason }`：范围合法但不满足。
 *
 * 宿主版本本身无法解析时**放行**并给出 `reason`——那种情况是本仓的版本号有问题，
 * 不应该因此把用户所有插件全部禁用。
 *
 * 宿主版本带预发布标记时（例如 fork 自用 `4.0.0-dev.0`）启用 `includePrerelease`，
 * 否则 `>=3.1.0` 这类范围会把预发布版本判为不满足。
 *
 * @param {unknown} requirement 插件声明的 range，空值表示不限制
 * @param {string} hostVersion 宿主版本（对应 `package.json` 的 `version`）
 * @returns {{ ok: boolean, invalid?: boolean, reason?: string }}
 */
export function checkHostVersion(requirement, hostVersion) {
  if (requirement === undefined || requirement === null || requirement === "") return { ok: true }

  if (!isValidRange(requirement))
    return {
      ok: false,
      invalid: true,
      reason: `声明的版本范围不是合法 semver range：「${String(requirement)}」`,
    }

  const host = semver.valid(hostVersion) ?? semver.coerce(hostVersion)?.version
  if (!host) return { ok: true, reason: `无法解析宿主版本「${hostVersion}」，已跳过版本校验` }

  const options = { includePrerelease: semver.prerelease(host) !== null }
  if (semver.satisfies(host, String(requirement), options)) return { ok: true }

  return { ok: false, reason: `要求 ${String(requirement)}，当前宿主为 ${host}` }
}
