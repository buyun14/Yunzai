import { makePluginEntry } from "../../helpers/pipeline.js"

/**
 * 影子运行的场景表。
 *
 * 单独成文件的原因：每个场景都是"配置 + 事件 + 插件集合"的三元组，
 * 跟断言逻辑混在一起会让两边都难读。
 *
 * @typedef {object} Scenario
 * @property {string} name 场景名（同时是用例名，必须唯一）
 * @property {string} fixture 事件样本名
 * @property {Record<string, unknown>} [overrides] 事件字段覆盖项
 * @property {{ group?: object, other?: object }} [cfg] 配置覆盖项
 * @property {(record: (label: string) => void) => Array<object>} [build] 造 priority 条目
 * @property {{ groupCD?: object, singleCD?: object, msgThrottle?: object }} [seed] 预置限流状态
 */

/** 样本里的固定值 */
const GROUP_ID = 67890
const USER_ID = 10001

/**
 * 造一个条目，并把原型上的方法包一层记录。
 *
 * `getContext` / `accept` / 命令处理器都走这里——两侧的记录序列因此可直接对拍。
 *
 * @param {string} name 插件名
 * @param {object} [decl] 数据字段（`rule` / `event` …）
 * @param {object} [methods] 原型方法
 * @param {(label: string) => void} record 记录回调
 * @returns {object} 调度条目
 */
function entry(name, decl, methods, record) {
  const built = makePluginEntry(name, decl, methods)

  for (const key of Object.getOwnPropertyNames(built.class.prototype)) {
    const original = built.class.prototype[key]
    if (key === "constructor" || typeof original !== "function") continue
    built.class.prototype[key] = async function (...args) {
      record(`${name}.${key}`)
      return original.apply(this, args)
    }
  }

  return built
}

/** 复读命令的规则 */
const ECHO_RULE = { reg: /^#?复读/, fnc: "onMsg" }

/**
 * @type {Scenario[]}
 */
export const SCENARIOS = [
  // ---- 插件筛选 ----
  {
    name: "没有插件时记「暂无插件处理」",
    fixture: "group-command",
  },
  {
    name: "rule 命中并执行处理器",
    fixture: "group-command",
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "rule 不命中",
    fixture: "group-command",
    build: record => [
      entry(
        "天气",
        { rule: [{ reg: /^#天气/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    // 真实插件（如 miao-plugin 的 components/App.js）的处理器经由 `this.e` 取事件，
    // 因此处理器必须以插件实例为 this 调用。夹具用箭头函数时这个约束测不出来，
    // 这里刻意照真实形态写。
    name: "处理器依赖 this.e",
    fixture: "group-command",
    build: record => [
      entry(
        "用this",
        { rule: [ECHO_RULE] },
        {
          async onMsg() {
            record(`用this.onMsg:${this.e.user_id}:${this.name}`)
            await this.e.reply("来自插件")
            return true
          },
        },
        record,
      ),
    ],
  },
  {
    name: "处理器返回 false 时继续同一插件的下一条规则",
    fixture: "group-command",
    build: record => [
      entry(
        "多规则",
        {
          rule: [
            { reg: /复读/, fnc: "first" },
            { reg: /复读/, fnc: "second" },
          ],
        },
        { first: async () => false, second: async () => true },
        record,
      ),
    ],
  },
  {
    name: "处理器返回 false 且无后续规则",
    fixture: "group-command",
    build: record => [
      entry(
        "单规则",
        { rule: [{ reg: /复读/, fnc: "onMsg" }] },
        { onMsg: async () => false },
        record,
      ),
    ],
  },
  {
    name: "前一个插件不匹配时继续下一个",
    fixture: "group-command",
    build: record => [
      entry(
        "天气",
        { rule: [{ reg: /^#天气/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
      entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record),
    ],
  },
  {
    name: "没有 event 声明的插件被排除",
    fixture: "group-command",
    build: record => {
      const built = entry("没声明", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)
      delete built.plugin.event
      return [built]
    },
  },
  {
    name: "event 声明不匹配的插件被排除",
    fixture: "group-command",
    build: record => [
      entry(
        "仅私聊",
        { event: "message.private.friend", rule: [ECHO_RULE] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "disable 命中的插件被排除",
    fixture: "group-command",
    cfg: { group: { disable: ["复读机"] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "enable 白名单不含该插件时被排除",
    fixture: "group-command",
    cfg: { group: { enable: ["别的插件"] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },

  // ---- accept ----
  {
    name: "accept 返回 return 时不进入 rule",
    fixture: "group-command",
    build: record => [
      entry(
        "靠accept",
        { accept: async () => "return", rule: [ECHO_RULE] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "accept 返回真值后进入 rule",
    fixture: "group-command",
    build: record => [
      entry("靠accept", { accept: async () => true }, {}, record),
      entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record),
    ],
  },

  // ---- context hook ----
  {
    name: "context hook 返回 continue 时放行",
    fixture: "group-command",
    build: record => [
      entry(
        "钩子",
        { getContext: () => ({ onMsg: "any" }) },
        { onMsg: async () => "continue" },
        record,
      ),
      entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record),
    ],
  },
  {
    name: "context hook 返回其他值时终止",
    fixture: "group-command",
    build: record => [
      entry(
        "钩子",
        { getContext: () => ({ onMsg: "any" }) },
        { onMsg: async () => "handled" },
        record,
      ),
      entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record),
    ],
  },
  {
    name: "getContext 返回空对象时跳过该插件",
    fixture: "group-command",
    build: record => [
      entry("空上下文", { getContext: () => ({}) }, { onMsg: async () => true }, record),
      entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record),
    ],
  },
  {
    // 真实 plugin.js 的 getContext 会经由 this.e 算会话键（conKey）。
    // 它要求两件事同时成立：方法必须以插件实例为 this 调用，
    // 且实例上必须已挂好本次事件的 e。缺任何一个都会抛 TypeError。
    name: "getContext 依赖 this.e（conKey 同形）",
    fixture: "group-command",
    build: record => [
      entry(
        "用conKey",
        {
          getContext(isGroup) {
            const key = `${this.name}.${this.e.self_id}.${isGroup ? this.e.group_id : this.e.user_id}`
            return isGroup ? { onMsg: key } : {}
          },
        },
        { onMsg: async () => "continue" },
        record,
      ),
      entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record),
    ],
  },

  // ---- 唤醒门槛 ----
  {
    name: "onlyReplyAt=1 且未 at 未带别名时不唤醒",
    fixture: "group-command",
    cfg: { group: { onlyReplyAt: 1 } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "onlyReplyAt=1 且 at 机器人时唤醒",
    fixture: "group-at-bot",
    cfg: { group: { onlyReplyAt: 1 } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "onlyReplyAt=1 且带别名时唤醒并剥离别名",
    fixture: "group-alias-prefix",
    cfg: { group: { onlyReplyAt: 1, botAlias: ["机器人"] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "onlyReplyAt=1 但 getContext 仍然执行",
    fixture: "group-command",
    cfg: { group: { onlyReplyAt: 1 } },
    build: record => [
      entry(
        "钩子",
        { getContext: () => ({ onMsg: "any" }) },
        { onMsg: async () => "continue" },
        record,
      ),
    ],
  },

  // ---- 权限 ----
  {
    name: "非主人触发 master 规则时发送提示",
    fixture: "group-command",
    build: record => [
      entry(
        "仅主人",
        { rule: [{ ...ECHO_RULE, permission: "master" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "群管理规则对成员拦截",
    fixture: "group-command",
    build: record => [
      entry(
        "仅管理",
        { rule: [{ ...ECHO_RULE, permission: "admin" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "群管理规则对管理员放行",
    fixture: "group-command",
    overrides: { member: { is_admin: true } },
    build: record => [
      entry(
        "仅管理",
        { rule: [{ ...ECHO_RULE, permission: "admin" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "群主规则对管理员拦截",
    fixture: "group-command",
    overrides: { member: { is_admin: true } },
    build: record => [
      entry(
        "仅群主",
        { rule: [{ ...ECHO_RULE, permission: "owner" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },

  // ---- 黑白名单 ----
  {
    name: "黑名单用户被拦截",
    fixture: "group-command",
    cfg: { other: { blackUser: [USER_ID] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "白名单用户不含该用户时被拦截",
    fixture: "group-command",
    cfg: { other: { whiteUser: [99999] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "白名单用户含该用户时放行",
    fixture: "group-command",
    cfg: { other: { whiteUser: [USER_ID] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "黑名单群被拦截",
    fixture: "group-command",
    cfg: { other: { blackGroup: [GROUP_ID] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "白名单群不含该群时被拦截",
    fixture: "group-command",
    cfg: { other: { whiteGroup: [111111] } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },

  // ---- 禁言与限流 ----
  {
    name: "群被禁言时拦截",
    fixture: "group-command",
    overrides: { group: { mute_left: 60 } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "全员禁言且发言者非管理非群主时拦截",
    fixture: "group-command",
    overrides: { group: { all_muted: true, is_admin: false, is_owner: false } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "全员禁言但发言者是群管理时放行",
    fixture: "group-command",
    overrides: { group: { all_muted: true, is_admin: true } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "群冷却生效时拦截",
    fixture: "group-command",
    seed: { groupCD: { [GROUP_ID]: true } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "单人冷却生效时拦截",
    fixture: "group-command",
    seed: { singleCD: { [`${GROUP_ID}.${USER_ID}`]: true } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "同文去重生效时拦截",
    fixture: "group-command",
    seed: { msgThrottle: { "12345:10001:#复读": true } },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "私聊消息不受群限流影响",
    fixture: "private-command",
    build: record => [
      entry(
        "复读机",
        { event: "message.private.*", rule: [{ reg: /^#?复读/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },

  // ---- 归一化细节 ----
  {
    name: "星铁前缀被归一化",
    fixture: "group-command",
    overrides: { raw_message: "#*抽卡", message: [{ type: "text", text: "#*抽卡" }] },
    build: record => [
      entry(
        "星铁",
        { rule: [{ reg: /^#星铁抽卡/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "绝区零前缀被归一化",
    fixture: "group-command",
    overrides: { raw_message: "#%抽卡", message: [{ type: "text", text: "#%抽卡" }] },
    build: record => [
      entry(
        "绝区零",
        { rule: [{ reg: /^#绝区零抽卡/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "斜杠前缀被转成井号",
    fixture: "group-command",
    overrides: { raw_message: "/复读", message: [{ type: "text", text: "/复读" }] },
    build: record => [entry("复读机", { rule: [ECHO_RULE] }, { onMsg: async () => true }, record)],
  },
  {
    name: "多段混合消息的 msg / at / img",
    fixture: "group-multi-segment",
    build: record => [
      entry(
        "复读机",
        { rule: [{ reg: /复读/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "引用消息的 reply_id 与 file",
    fixture: "group-reply-with-file",
    build: record => [
      entry(
        "复读机",
        { rule: [{ reg: /复读/, fnc: "onMsg" }] },
        { onMsg: async () => true },
        record,
      ),
    ],
  },
  {
    name: "notice 事件同样走流水线",
    fixture: "notice-group-increase",
    build: record => [entry("入群提醒", {}, { onMsg: async () => true }, record)],
  },
]
