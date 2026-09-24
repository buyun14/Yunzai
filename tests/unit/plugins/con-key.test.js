import { describe, expect, it } from "vitest"
import { umoOf } from "../../../lib/message/umo.js"

const { default: Plugin } = await import("../../../lib/plugins/plugin.js")

/**
 * `Plugin.conKey()`（阶段 5：`umo` 的剩余落点）。
 *
 * 它以前是本仓第四份手拼的会话键（`<插件名>.<self_id>.<group_id|user_id>`），
 * 现在统一走 `umoOf()`。键只作内存 `stateArr` 的下标，所以格式变化不影响已存数据；
 * 真正要守住的是**写入与读取用同一个键**——不一致会让上下文静默丢失。
 */

/**
 * 造一个带事件的最小插件实例。
 *
 * @param {Record<string, unknown>} [fields] 要挂到实例上的字段
 * @param {Record<string, unknown>} [event] 事件对象
 * @returns {any} 插件实例
 */
function makePlugin(fields = {}, event = undefined) {
  class Demo extends Plugin {}
  // 基类的构造函数是解构参数的（`{ name = "your-plugin", ... }`），必须传对象；
  // `e` 不在构造参数里，它是外部注入的
  const instance = /** @type {any} */ (new Demo({ name: "复读机" }))
  Object.assign(instance, { e: event }, fields)
  return instance
}

describe("conKey", () => {
  it("按群开会话时是 <插件名>.<adapter>:<self_id>:group:<group_id>", () => {
    const instance = makePlugin(
      {},
      { adapter_id: "QQ", self_id: 12345, group_id: 67890, user_id: 10001 },
    )
    expect(instance.conKey(true)).toBe("复读机.QQ:12345:group:67890")
  })

  it("按人开会话时用 user 作用域，而不是私聊会话", () => {
    // 消息在群里、插件却只想为某个人开槽（“等这个人回复”）——这时不能用
    // `private`，否则群里所有人会共用一个槽
    const instance = makePlugin(
      {},
      { adapter_id: "QQ", self_id: 12345, group_id: 67890, user_id: 10001 },
    )
    expect(instance.conKey(false)).toBe("复读机.QQ:12345:user:10001")
    expect(instance.conKey(false)).not.toContain("private")
  })

  it("群里两个不同的人拿到两个不同的槽", () => {
    const event = { adapter_id: "QQ", self_id: 12345, group_id: 67890, user_id: 10001 }
    const first = makePlugin({}, event)
    const second = makePlugin({}, { ...event, user_id: 20002 })

    expect(first.conKey(false)).not.toBe(second.conKey(false))
    // 但群会话是同一个
    expect(first.conKey(true)).toBe(second.conKey(true))
  })

  it("实例字段优先于 e 上的字段（保留原有回落顺序）", () => {
    const instance = makePlugin(
      { self_id: 999 },
      { adapter_id: "QQ", self_id: 12345, group_id: 67890 },
    )
    expect(instance.conKey(true)).toBe("复读机.QQ:999:group:67890")
  })

  it("没有 e 时也不抛错（缺失的段落成 undefined）", () => {
    const instance = makePlugin()
    expect(instance.conKey(true)).toBe("复读机.unknown:undefined:group:undefined")
  })

  it("写入与读取用的是同一个键：setContext 之后 getContext 取得到", () => {
    // 这是本次改动唯一真正会出事的地方——键不一致时 getContext 返回 undefined，
    // 而调用方通常只看到“等待超时”，完全指不到原因
    const instance = makePlugin(
      {},
      { adapter_id: "QQ", self_id: 12345, group_id: 67890, user_id: 10001 },
    )

    instance.setContext("wait", true, 0)
    expect(instance.getContext("wait", true)).toBe(instance.e)

    instance.finish("wait", true)
    expect(instance.getContext("wait", true)).toBeUndefined()
  })

  it("按人开的槽与按群开的槽互不干扰", () => {
    const instance = makePlugin(
      {},
      { adapter_id: "QQ", self_id: 12345, group_id: 67890, user_id: 10001 },
    )

    instance.setContext("wait", false, 0)
    expect(instance.getContext("wait", true)).toBeUndefined()
    expect(instance.getContext("wait", false)).toBe(instance.e)
  })
})

describe("umoOf 的 scope 选项", () => {
  it("缺省按事件自身判定", () => {
    const event = { adapter_id: "QQ", self_id: 12345, message_type: "group", group_id: 67890 }
    expect(umoOf(event)).toBe("QQ:12345:group:67890")
    expect(umoOf({ ...event, message_type: "private" })).toBe("QQ:12345:private:undefined")
  })

  it("显式指定 scope 时按指定的来（group 取 group_id，其余取 user_id）", () => {
    const event = { adapter_id: "QQ", self_id: 12345, group_id: 67890, user_id: 10001 }
    expect(umoOf(event, { scope: "group" })).toBe("QQ:12345:group:67890")
    expect(umoOf(event, { scope: "user" })).toBe("QQ:12345:user:10001")
  })
})
