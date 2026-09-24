/**
 * 宿主配置的替身。
 *
 * 默认值刻意照抄 `config/default_config/{group,other}.yaml`——
 * 如果这里用"假默认值"，阶段单测通过但真实行为不同，测试就失去了意义。
 *
 * 用法：
 * ```js
 * const cfg = createConfigStub({ groups: { 67890: { onlyReplyAt: 1 } }, other: { blackUser: [10001] } })
 * ```
 */

/** 与 `config/default_config/group.yaml` 的 `default` 段一致 */
const GROUP_DEFAULTS = {
  groupCD: 500,
  singleCD: 2000,
  onlyReplyAt: 0,
  botAlias: ["云崽", "云宝"],
  addLimit: 0,
  addPrivate: 1,
  addReply: 1,
  addAt: 0,
  addRecall: 60,
  // 与默认配置一致：这两条会让名字相同的插件被禁用
  disable: ["禁用示例", "支持多个"],
  enable: undefined,
}

/** 与 `config/default_config/other.yaml` 一致（列表类字段默认都是空） */
const OTHER_DEFAULTS = {
  autoFriend: 1,
  autoGroup: 0,
  autoQuit: 50,
  masterQQ: [],
  master: [],
  disablePrivate: false,
  disableAdopt: ["stoken"],
  whiteGroup: [],
  whiteUser: [],
  blackGroup: [],
  blackUser: [],
}

/**
 * 造一个配置替身。
 *
 * @param {object} [overrides] 覆盖项
 * @param {Record<string, object>} [overrides.groups] 按 `群号` 或 `bot:群` 覆盖群配置
 * @param {object} [overrides.other] 覆盖 other 配置
 * @param {object} [overrides.bot] 覆盖 bot 配置
 * @param {string} [overrides.version] 宿主版本（用于版本闸门测试）
 * @returns {Record<string, unknown> & { calls: { getGroup: unknown[][], getOther: number } }}
 */
export function createConfigStub(overrides = {}) {
  /** @type {{ getGroup: unknown[][], getOther: number }} */
  const calls = { getGroup: [], getOther: 0 }
  const groups = overrides.groups ?? {}
  const other = { ...OTHER_DEFAULTS, ...overrides.other }

  return {
    calls,
    package: { name: "trss-yunzai", version: overrides.version ?? "3.1.3" },
    bot: {
      file_watch: false,
      plugin_load_timeout: 60,
      strict_plugin_version: true,
      msg_type_count: false,
      ...overrides.bot,
    },
    server: { port: 2536, auth: {} },
    master: {},
    /**
     * 解析群配置。键的优先级与 `lib/config/config.js` 的 `getGroup()` 一致。
     *
     * @param {unknown} selfId bot 账号
     * @param {unknown} groupId 群号
     * @returns {object} 合并后的群配置
     */
    getGroup(selfId, groupId) {
      calls.getGroup.push([selfId, groupId])
      const botKey = `${selfId}:${groupId}`
      return {
        ...GROUP_DEFAULTS,
        ...(groups[`${selfId}:default`] ?? {}),
        ...(groups[groupId] ?? {}),
        ...(groups[botKey] ?? {}),
      }
    },
    /**
     * 取 other 配置。
     * @returns {object} 一份拷贝
     */
    getOther() {
      calls.getOther += 1
      return { ...other }
    },
  }
}
