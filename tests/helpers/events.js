import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * 事件样本的加载与"适配器载荷 → 可运行事件"的构造。
 *
 * 详见 `tests/fixtures/events/README.md`。
 */

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/events/", import.meta.url))

/**
 * 列出全部样本名（不含扩展名），按字典序。
 *
 * @returns {string[]} 样本名列表
 */
export function listFixtures() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter(file => file.endsWith(".json"))
    .map(file => file.replace(/\.json$/, ""))
    .sort()
}

/**
 * 读取样本的**原始对象**（每次调用返回新的深拷贝，避免测试之间互相污染）。
 *
 * @param {string} name 样本名（不含 `.json`）
 * @returns {Record<string, unknown>} 原始载荷
 */
export function readFixture(name) {
  return structuredClone(
    JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8")),
  )
}

/**
 * 给 `group` / `friend` 这类"既有数据又有方法"的对象补上方法桩。
 *
 * 与 `lib/bot.js` 的 `prepareEvent()` 对齐：真实环境里这些方法也是在那里被补上的。
 *
 * @param {Record<string, unknown>} target 目标对象
 * @param {Array<Record<string, unknown>>} sent 记录被"发送"出去的消息
 * @returns {Record<string, unknown>} 同一个对象
 */
function attachMethods(target, sent) {
  target.sendMsg ??= async msg => {
    sent.push({ msg, via: "sendMsg" })
    return { message_id: `sent-${sent.length}` }
  }
  target.recallMsg ??= async () => true
  target.getMsg ??= async () => ({ message: [] })
  target.sendFile ??= async () => ({})
  target.getInfo ??= async () => target
  target.pickMember ??= userId => ({
    user_id: userId,
    nickname: "成员",
    card: "成员",
    is_owner: false,
    is_admin: false,
  })
  return target
}

/**
 * 把样本构造成可直接交给流水线的事件对象。
 *
 * @param {string} name 样本名（不含 `.json`）
 * @param {Record<string, unknown>} [overrides] 覆盖字段（可包含函数，因此不参与深拷贝）
 * @returns {{ event: Record<string, unknown>, sent: Array<Record<string, unknown>> }}
 *   `event` 为事件对象，`sent` 记录该事件产生的所有"发送"
 */
export function makeEvent(name, overrides = {}) {
  const event = readFixture(name)
  /** @type {Array<Record<string, unknown>>} */
  const sent = []

  if (event.group) attachMethods(event.group, sent)
  if (event.friend) attachMethods(event.friend, sent)

  // 与 prepareEvent 一致：没有 member 时由 group.pickMember 派生
  if (event.group && event.user_id !== undefined && !event.member)
    event.member = event.group.pickMember(event.user_id)

  event.sender ??= { user_id: event.user_id }
  event.adapter_id ??= "QQ"
  event.adapter_name ??= "OneBotv11"

  // 真实的 e.reply 是 PreProcessStage 包装出来的（注入 at/引用、异常兜底、定时撤回）；
  // 这里只做"记录下来"，避免测试断言里混入发送细节。
  // 调用方显式提供了 reply 时不覆盖它——否则 overrides 会被这里悄悄吃掉。
  if (!("reply" in overrides))
    Object.defineProperty(event, "reply", {
      value: async (msg = "", quote = false, data = {}) => {
        sent.push({ msg, quote, data })
        return { message_id: `sent-${sent.length}` }
      },
      enumerable: false,
      writable: true,
      configurable: true,
    })

  Object.assign(event, overrides)

  return { event, sent }
}
