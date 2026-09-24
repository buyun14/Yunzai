import { describe, expect, it } from "vitest"
import { createConfigStub } from "../../helpers/config.js"
import { listFixtures, makeEvent, readFixture } from "../../helpers/events.js"

/**
 * 校验样本与夹具自身。
 *
 * 夹具坏了会让后面所有阶段测试"静默变弱"——比如扫描范围意外为空时断言永远通过。
 * 所以夹具本身也要有测试。
 */

/** 归一化阶段的**输出**字段：样本里不得预先出现，否则测试会平凡通过 */
const NORMALIZED_FIELDS = [
  "msg",
  "img",
  "at",
  "atBot",
  "hasAlias",
  "isPrivate",
  "isGroup",
  "isMaster",
  "only_reply_at",
  "logText",
  "logFnc",
  "file",
  "reply_id",
  "getReply",
]

describe("事件样本结构", () => {
  it("样本数量不少于 README 中列出的条数（防止被误删）", () => {
    expect(listFixtures().length).toBeGreaterThanOrEqual(14)
  })

  it("每条样本都有 post_type 与 self_id", () => {
    for (const name of listFixtures()) {
      const fixture = readFixture(name)
      expect(typeof fixture.post_type, name).toBe("string")
      expect(fixture.self_id, name).toBeTypeOf("number")
    }
  })

  it("post_type 覆盖 message / notice / request 三类", () => {
    const kinds = new Set(listFixtures().map(name => readFixture(name).post_type))
    expect([...kinds].sort()).toEqual(["message", "notice", "request"])
  })

  it("message 类样本都有 message_type 与 message 数组", () => {
    for (const name of listFixtures()) {
      const fixture = readFixture(name)
      if (fixture.post_type !== "message") continue
      expect(typeof fixture.message_type, name).toBe("string")
      expect(Array.isArray(fixture.message), name).toBe(true)
      expect(fixture.message.length, name).toBeGreaterThan(0)
    }
  })

  it("群类样本都带禁言与权限判断需要的群状态字段", () => {
    for (const name of listFixtures()) {
      const fixture = readFixture(name)
      if (!fixture.group) continue
      for (const field of ["is_owner", "is_admin", "mute_left", "all_muted"])
        expect(fixture.group, `${name} 缺少 group.${field}`).toHaveProperty(field)
    }
  })

  it("样本不得预先包含归一化输出字段（否则阶段测试会平凡通过）", () => {
    for (const name of listFixtures()) {
      const fixture = readFixture(name)
      const leaked = NORMALIZED_FIELDS.filter(field => field in fixture)
      expect(leaked, `${name} 预置了归一化字段`).toEqual([])
    }
  })

  it("样本是纯数据：可深拷贝，且每次读取互不影响", () => {
    const first = readFixture("group-command")
    first.message.push({ type: "text", text: "污染" })
    first.group.all_muted = true

    const second = readFixture("group-command")
    expect(second.message).toHaveLength(1)
    expect(second.group.all_muted).toBe(false)
  })
})

describe("makeEvent", () => {
  it("补上 group 的方法桩，并由 pickMember 派生 member", () => {
    const { event } = makeEvent("group-command")
    expect(typeof event.group.sendMsg).toBe("function")
    expect(typeof event.group.recallMsg).toBe("function")
    expect(typeof event.group.pickMember).toBe("function")
    expect(event.member).toMatchObject({ user_id: 10001 })
  })

  it("补上 adapter_id / adapter_name（适配器过滤会用到）", () => {
    const { event } = makeEvent("group-command")
    expect(event.adapter_id).toBe("QQ")
    expect(event.adapter_name).toBe("OneBotv11")
  })

  it("私聊样本不补 group 相关内容", () => {
    const { event } = makeEvent("private-command")
    expect(event.group).toBeUndefined()
    expect(event.member).toBeUndefined()
  })

  it("e.reply 只记录不发送，且不出现在 Object.keys 里", async () => {
    const { event, sent } = makeEvent("group-command")
    expect(Object.keys(event)).not.toContain("reply")

    await event.reply("你好", true, { at: true })
    expect(sent).toEqual([{ msg: "你好", quote: true, data: { at: true } }])
  })

  it("每次调用返回独立的事件与 sent 数组", () => {
    const a = makeEvent("group-command")
    const b = makeEvent("group-command")
    expect(a.event).not.toBe(b.event)
    expect(a.sent).not.toBe(b.sent)

    a.event.group.all_muted = true
    expect(b.event.group.all_muted).toBe(false)
  })

  it("overrides 可覆盖字段，且允许传入函数", async () => {
    const { event, sent } = makeEvent("group-command", {
      user_id: 42,
      reply: async msg => {
        sent.push({ msg, via: "custom" })
      },
    })
    expect(event.user_id).toBe(42)

    await event.reply("自定义")
    expect(sent).toEqual([{ msg: "自定义", via: "custom" }])
  })

  it("样本的 group 状态可被覆盖，用于构造禁言/白名单等场景", () => {
    const { event } = makeEvent("group-muted")
    expect(event.group.all_muted).toBe(true)
    expect(event.group.mute_left).toBe(120)
  })
})

describe("createConfigStub", () => {
  it("默认值照抄线上的 group.yaml / other.yaml", () => {
    const cfg = createConfigStub()
    const group = cfg.getGroup(12345, 67890)
    expect(group).toMatchObject({ groupCD: 500, singleCD: 2000, onlyReplyAt: 0 })
    expect(group.botAlias).toEqual(["云崽", "云宝"])
    expect(cfg.getOther()).toMatchObject({ autoFriend: 1, autoGroup: 0 })
  })

  it("getGroup 的键优先级：群号 < bot:群", () => {
    const cfg = createConfigStub({
      groups: { 67890: { onlyReplyAt: 1 }, "12345:67890": { onlyReplyAt: 2 } },
    })
    expect(cfg.getGroup(12345, 67890).onlyReplyAt).toBe(2)
    expect(cfg.getGroup(99999, 67890).onlyReplyAt).toBe(1)
  })

  it("支持 bot 级默认值", () => {
    const cfg = createConfigStub({ groups: { "12345:default": { onlyReplyAt: 1 } } })
    expect(cfg.getGroup(12345, 111).onlyReplyAt).toBe(1)
    expect(cfg.getGroup(99999, 111).onlyReplyAt).toBe(0)
  })

  it("记录 getGroup / getOther 的调用次数，便于断言'不该读配置'的场景", () => {
    const cfg = createConfigStub()
    cfg.getGroup(1, 2)
    cfg.getOther()
    cfg.getOther()
    expect(cfg.calls.getGroup).toEqual([[1, 2]])
    expect(cfg.calls.getOther).toBe(2)
  })

  it("宿主版本可覆盖（版本闸门测试会用到）", () => {
    expect(createConfigStub({ version: "4.0.0" }).package.version).toBe("4.0.0")
  })
})
