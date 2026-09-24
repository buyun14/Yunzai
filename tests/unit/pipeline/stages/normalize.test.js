import { describe, expect, it } from "vitest"
import { PipelineContext } from "../../../../lib/pipeline/context.js"
import { NormalizeStage } from "../../../../lib/pipeline/stages/normalize.js"
import { createConfigStub } from "../../../helpers/config.js"
import { makeEvent } from "../../../helpers/events.js"

/**
 * 跑一次归一化阶段。
 *
 * @param {string} name 样本名
 * @param {{ overrides?: object, cfg?: object, master?: Record<string, string[]> }} [opts] 选项
 * @returns {Promise<{ event: Record<string, unknown>, sent: unknown[], cfg: object }>} 结果
 */
async function normalize(name, opts = {}) {
  const cfg = createConfigStub(opts.cfg)
  if (opts.master) cfg.master = opts.master

  const ctx = new PipelineContext({ loader: {}, profileKey: "test", cfg })
  const stage = new NormalizeStage()
  await stage.initialize(ctx)

  const { event, sent } = makeEvent(name, opts.overrides)
  // ProfileResolveStage 会把群配置写进状态；这里手动补上（`deal()` 第 3 步等价）
  ctx.stateOf(event).groupCfg = cfg.getGroup(event.self_id, event.group_id)

  await stage.process(event)
  return { event, sent, cfg }
}

describe("NormalizeStage：消息解析", () => {
  it("群聊文本消息拼出 msg 与 isGroup", async () => {
    const { event } = await normalize("group-command")
    expect(event.msg).toBe("#复读")
    expect(event.isGroup).toBe(true)
    expect(event.isPrivate).toBeUndefined()
  })

  it("at 自己时置 atBot，不会写入 at", async () => {
    const { event } = await normalize("group-at-bot")
    expect(event.atBot).toBe(true)
    expect(event.at).toBeUndefined()
    expect(event.msg).toBe("#复读")
  })

  it("at 别人时写入 at，不置 atBot", async () => {
    const { event } = await normalize("group-multi-segment")
    expect(event.at).toBe(10002)
    expect(event.atBot).toBeUndefined()
  })

  it("文本 + at + 图片混合时 msg / at / img 同时产出", async () => {
    const { event } = await normalize("group-multi-segment")
    expect(event.msg).toBe("#复读")
    expect(event.img).toEqual(["https://example.invalid/a.png"])
  })

  it("纯图片消息的 msg 为空", async () => {
    const { event } = await normalize("group-image-only")
    expect(event.msg).toBeUndefined()
    expect(event.img).toEqual(["https://example.invalid/b.png"])
  })

  it("reply 段产出 reply_id 与 getReply", async () => {
    const { event } = await normalize("group-reply-with-file")
    expect(event.reply_id).toBe(999)
    expect(typeof event.getReply).toBe("function")
    await expect(event.getReply()).resolves.toEqual({ message: [] })
  })

  it("file 段整体写入 e.file", async () => {
    const { event } = await normalize("group-reply-with-file")
    expect(event.file).toMatchObject({ type: "file", name: "report.txt" })
  })

  it("json 段被序列化进 msg", async () => {
    const { event } = await normalize("group-json-card")
    expect(JSON.parse(String(event.msg))).toMatchObject({ desc: "测试卡片" })
  })

  it("未识别的段类型（record / video / forward / poke）不影响旧字段", async () => {
    // 改造前的既有行为：未识别类型不参与旧字段派生。
    const { event } = await normalize("group-unsupported-segments")
    expect(event.msg).toBe("#复读")
    // record 不会被当成 file
    expect(event.file).toBeUndefined()
    // poke 不产生任何字段
    expect(event).not.toHaveProperty("poke")
    // recall 是 markScope 依据 message_id 挂上的，与段类型无关
    expect(typeof event.recall).toBe("function")
  })

  it("未识别的段类型仍然进了 components（阶段 4 v1 起不再静默丢弃）", async () => {
    const { event } = await normalize("group-unsupported-segments")
    expect(
      /** @type {Array<{ type: string }>} */ (event.components).map(item => item.type),
    ).toEqual(["plain", "record", "video", "forward", "poke"])
  })

  it("没有 message 的事件（通知类）也拿到空的 components", async () => {
    const { event } = await normalize("notice-group-increase")
    expect(event.components).toEqual([])
  })

  it("文本的空白与前导符号被归一化", async () => {
    const { event } = await normalize("group-multi-segment")
    // 样本里的文本是 "#复读 "（带尾随空格）
    expect(event.msg).toBe("#复读")
  })

  it("前导 / 在 /→# 开启时转为 #", async () => {
    const { event } = await normalize("group-command", {
      overrides: { message: [{ type: "text", text: "/复读" }] },
    })
    expect(event.msg).toBe("#复读")
  })

  it("前导 / 在 /→# 关闭时保持原样", async () => {
    const { event } = await normalize("group-command", {
      cfg: { bot: { "/→#": false } },
      overrides: { message: [{ type: "text", text: "/复读" }] },
    })
    expect(event.msg).toBe("/复读")
  })
})

describe("NormalizeStage：群聊 / 私聊判定", () => {
  it("私聊消息置 isPrivate 且不置 isGroup", async () => {
    const { event } = await normalize("private-command")
    expect(event.isPrivate).toBe(true)
    expect(event.isGroup).toBeUndefined()
  })

  it("notice.group.increase 判为群聊", async () => {
    const { event } = await normalize("notice-group-increase")
    expect(event.isGroup).toBe(true)
    expect(event.isPrivate).toBeUndefined()
  })

  it("request.friend.add 既不是群聊也不是私聊", async () => {
    // 这是一条容易漏掉的边界：适配器对 request 事件不提供 message_type / notice_type，
    // 因此 isGroup / isPrivate 都不会赋值。旧实现如此，本阶段保持一致。
    const { event } = await normalize("request-friend-add")
    expect(event.isGroup).toBeUndefined()
    expect(event.isPrivate).toBeUndefined()
  })

  it("logText 含群名与发送者名片", async () => {
    const { event } = await normalize("group-command")
    expect(event.logText).toBe("[测试群(67890), 测试用户(10001)][#复读]")
  })

  it("logText 在私聊下只有昵称", async () => {
    const { event } = await normalize("private-command")
    expect(event.logText).toBe("[测试用户(10001)][#复读]")
  })

  it("sender.card 缺失时用 nickname 兜底", async () => {
    const { event } = await normalize("group-command", {
      overrides: { sender: { user_id: 10001, nickname: "只有昵称" } },
    })
    expect(event.sender.card).toBe("只有昵称")
  })

  it("群聊消息挂上 recall（绑定 message_id）", async () => {
    const { event } = await normalize("group-command")
    expect(typeof event.recall).toBe("function")
    await expect(event.recall()).resolves.toBe(true)
  })
})

describe("NormalizeStage：主人判定", () => {
  it("配置里声明的用户被标为 isMaster", async () => {
    const { event } = await normalize("group-command", { master: { 12345: ["10001"] } })
    expect(event.isMaster).toBe(true)
  })

  it("未声明的用户不是 isMaster", async () => {
    const { event } = await normalize("group-command", { master: { 12345: ["99999"] } })
    expect(event.isMaster).toBeUndefined()
  })

  it("master 表按 self_id 分账号", async () => {
    const { event } = await normalize("group-command", { master: { 99999: ["10001"] } })
    expect(event.isMaster).toBeUndefined()
  })
})

describe("NormalizeStage：别名剥离", () => {
  it("群聊未 at 机器人且文本以别名开头时剥离并置 hasAlias", async () => {
    const { event } = await normalize("group-alias-prefix", {
      cfg: { groups: { "12345:default": { botAlias: ["机器人"] } } },
    })
    expect(event.msg).toBe("#复读")
    expect(event.hasAlias).toBe(true)
  })

  it("at 了机器人时不剥离别名", async () => {
    const { event } = await normalize("group-at-bot", {
      overrides: {
        message: [
          { type: "at", qq: 12345 },
          { type: "text", text: "机器人#复读" },
        ],
      },
      cfg: { groups: { "12345:default": { botAlias: ["机器人"] } } },
    })
    expect(event.msg).toBe("机器人#复读")
    expect(event.hasAlias).toBeUndefined()
  })

  it("别名不匹配时不做任何改动", async () => {
    const { event } = await normalize("group-command")
    expect(event.hasAlias).toBeUndefined()
    expect(event.msg).toBe("#复读")
  })

  it("私聊不剥离别名", async () => {
    const { event } = await normalize("private-command", {
      overrides: { message: [{ type: "text", text: "云崽#复读" }] },
    })
    expect(event.msg).toBe("云崽#复读")
  })
})

describe("NormalizeStage：only_reply_at", () => {
  it("onlyReplyAt=0（默认）时始终为 true", async () => {
    const { event } = await normalize("group-no-match")
    expect(event.only_reply_at).toBe(true)
  })

  it("onlyReplyAt=1 且未 at 机器人、无别名时为 false", async () => {
    const { event } = await normalize("group-no-match", {
      cfg: { groups: { "12345:default": { onlyReplyAt: 1 } } },
    })
    expect(event.only_reply_at).toBe(false)
  })

  it("onlyReplyAt=1 且 at 了机器人时为 true", async () => {
    const { event } = await normalize("group-at-bot", {
      cfg: { groups: { "12345:default": { onlyReplyAt: 1 } } },
    })
    expect(event.only_reply_at).toBe(true)
  })

  it("onlyReplyAt=1 且命中别名时为 true", async () => {
    const { event } = await normalize("group-alias-prefix", {
      cfg: { groups: { "12345:default": { onlyReplyAt: 1, botAlias: ["机器人"] } } },
    })
    expect(event.only_reply_at).toBe(true)
  })

  it("onlyReplyAt=2 时主人不受限制", async () => {
    const { event } = await normalize("group-no-match", {
      cfg: { groups: { "12345:default": { onlyReplyAt: 2 } } },
      master: { 12345: ["10001"] },
    })
    expect(event.only_reply_at).toBe(true)
  })

  it("私聊始终为 true", async () => {
    const { event } = await normalize("private-command", {
      cfg: { groups: { "12345:default": { onlyReplyAt: 1 } } },
    })
    expect(event.only_reply_at).toBe(true)
  })
})
