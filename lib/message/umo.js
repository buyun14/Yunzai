/**
 * 会话唯一键 `umo`：`<adapter_id>:<self_id>:<scope>:<peer_id>`。
 *
 * 对应 `docs/refactor/04-message-adapter.md` §3.3。
 *
 * # 它要解决的问题
 *
 * "这是哪个会话"在本仓被反复手工拼装过：限流表的键是 `group_id`，
 * 单人冷却的键是 `${group_id}.${user_id}`，同文去重是
 * `${self_id}:${user_id}:${raw_message}`，`plugin.js` 的 `conKey()` 又是另一个格式。
 * 键空间不一致的代价在阶段 2 已经付过一次——旧实现的冷却表键里漏了 `self_id`，
 * 多账号同群会互相拦截（见 `rate-limit-check.js` 的类注释）。
 *
 * `umo` 把"会话"定义成一处：**谁（adapter + self_id）在哪个作用域的哪一个对端**。
 * 需要按会话记账的地方（冷却、去重、会话变量、日志）都用它，就不会再各自发明格式。
 *
 * # 格式
 *
 * | 场景 | umo |
 * |---|---|
 * | OneBotv11 账号 12345 在群 67890 | `QQ:12345:group:67890` |
 * | OneBotv11 账号 12345 与用户 10001 私聊 | `QQ:12345:private:10001` |
 * | Satori 账号 abc 在群 g1 | `Satori:abc:group:g1` |
 *
 * 前两段是"谁"，后两段是"哪里"。将来若出现频道（guild/channel），
 * 只需扩展 `scope` 的取值，前两段不变。
 *
 * # 为什么是纯函数
 *
 * 它只读事件上已有的字段（`adapter_id` 由 `prepareEvent()` 写入，`self_id` /
 * `group_id` / `user_id` 来自适配器载荷）。不依赖流水线上下文、不写状态，
 * 因此谁都能算——包括在 `NormalizeStage` 之前的 `RateLimitCheckStage`。
 */

/**
 * 算出事件所属会话的唯一键。
 *
 * 分类沿用现有语义：群作用域对应 `message_type` / `notice_type` / `request_type`
 * 为 `"group"` 的事件，**其余一律算私聊**。注意请求类事件（`request.friend.add`）
 * 既不是群也不是私聊，现有代码对它们不赋 `isGroup` / `isPrivate`；
 * 这里按"不是群即私聊"归类，`request.group.*` 因为有 `group_id` 也归到群作用域，
 * 这样它们至少不会与私聊会话撞键。
 *
 * `adapter_id` 缺失时依次回落到 `adapter_name` 与 `"unknown"`——测试夹具与
 * 部分第三方适配器可能只给后者。
 *
 * @param {Record<string, unknown>} event 事件对象
 * @returns {string} 形如 `QQ:12345:group:67890` 的会话键
 */
export function umoOf(event) {
  const kind = event.message_type ?? event.notice_type ?? event.request_type
  const scope = kind === "group" ? "group" : "private"
  const peer = scope === "group" ? event.group_id : event.user_id
  const adapter = event.adapter_id ?? event.adapter_name ?? "unknown"

  return `${adapter}:${event.self_id}:${scope}:${peer}`
}
