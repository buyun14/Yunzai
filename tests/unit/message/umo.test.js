import { describe, expect, it } from "vitest"
import { umoOf } from "../../../lib/message/umo.js"

/**
 * `lib/message/umo.js` 的单测。
 *
 * 对应的验收项（`04-message-adapter.md` §6）：`umo` 单一实现，且各场景下的
 * 取值符合 §3.3 的格式表。格式是**对外契约**（限流表键、将来的会话配置键），
 * 所以这里逐字断言字符串，而不是只断言"两处相等"。
 */

describe("umoOf：格式", () => {
  it("群聊：adapter:self_id:group:group_id", () => {
    expect(
      umoOf({ adapter_id: "QQ", self_id: 12345, message_type: "group", group_id: 67890 }),
    ).toBe("QQ:12345:group:67890")
  })

  it("私聊：adapter:self_id:private:user_id", () => {
    expect(
      umoOf({ adapter_id: "QQ", self_id: 12345, message_type: "private", user_id: 10001 }),
    ).toBe("QQ:12345:private:10001")
  })

  it("适配器前缀来自 adapter_id，不同适配器不会撞键", () => {
    expect(
      umoOf({ adapter_id: "Satori", self_id: "abc", message_type: "group", group_id: "g1" }),
    ).toBe("Satori:abc:group:g1")
  })

  it("群通知走群作用域", () => {
    expect(umoOf({ adapter_id: "QQ", self_id: 12345, notice_type: "group", group_id: 67890 })).toBe(
      "QQ:12345:group:67890",
    )
  })

  it("好友通知走私聊作用域", () => {
    expect(umoOf({ adapter_id: "QQ", self_id: 12345, notice_type: "friend", user_id: 10001 })).toBe(
      "QQ:12345:private:10001",
    )
  })

  it("好友请求走私聊作用域", () => {
    expect(
      umoOf({ adapter_id: "QQ", self_id: 12345, request_type: "friend", user_id: 10001 }),
    ).toBe("QQ:12345:private:10001")
  })

  it("群请求带 group_id 时走群作用域", () => {
    // 请求类事件既不是群也不是私聊（现有代码不赋 isGroup/isPrivate），
    // 这里按"不是群即私聊"归类，至少不会与私聊会话撞键。
    expect(
      umoOf({
        adapter_id: "QQ",
        self_id: 12345,
        request_type: "group",
        group_id: 67890,
        user_id: 10001,
      }),
    ).toBe("QQ:12345:group:67890")
  })

  it("adapter_id 缺失时回落到 adapter_name，再回落到 unknown", () => {
    expect(
      umoOf({ adapter_name: "OneBotv11", self_id: 1, message_type: "group", group_id: 2 }),
    ).toBe("OneBotv11:1:group:2")
    expect(umoOf({ self_id: 1, message_type: "group", group_id: 2 })).toBe("unknown:1:group:2")
  })
})

describe("umoOf：区分能力", () => {
  it("同一账号的同群、私聊、另一个群是三个不同的键", () => {
    const base = { adapter_id: "QQ", self_id: 12345 }
    const keys = [
      umoOf({ ...base, message_type: "group", group_id: 67890 }),
      umoOf({ ...base, message_type: "group", group_id: 11111 }),
      umoOf({ ...base, message_type: "private", user_id: 10001 }),
    ]
    expect(new Set(keys).size).toBe(3)
  })

  it("不同账号在同一群里是不同的键", () => {
    const base = { adapter_id: "QQ", message_type: "group", group_id: 67890 }
    expect(umoOf({ ...base, self_id: 12345 })).not.toBe(umoOf({ ...base, self_id: 54321 }))
  })

  it("群里的两个对端如果 group_id 相同就是同一个会话（与 user_id 无关）", () => {
    // umo 描述的是"会话"而不是"人"：同一个群的两个人属于同一个群会话。
    // 需要按人隔离的地方（单人冷却、同文去重）自己再拼 user_id。
    const base = { adapter_id: "QQ", self_id: 12345, message_type: "group", group_id: 67890 }
    expect(umoOf({ ...base, user_id: 10001 })).toBe(umoOf({ ...base, user_id: 20002 }))
  })
})
