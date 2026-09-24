import { beforeEach, describe, expect, it, vi } from "vitest"

import util from "../../lib/util.js"

/**
 * `Bot.serverAuth` 的令牌比对。
 *
 * # 为什么要接受 `Bearer <令牌>`
 *
 * `Authorization: Bearer <token>` 是 HTTP 约定俗成的写法，而**SnowLuma**
 * （OneBot v11 客户端）就自动给值加上 `Bearer ` 前缀。配置里的令牌不会带这个
 * 前缀，于是原先的**全等比较**让它在请求头和查询参数两条路上都过不去，日志里
 * 只有一句 `Authorization 鉴权失败`——配置看起来完全正确，排查方向很容易被带偏。
 *
 * 反向也不能要求配置里写成 `Bearer xxx`：宿主自己发出去的 `/File/...` URL 带的是
 * **裸令牌**（见 `fileToUrl`），那样又认证不了。
 *
 * 所以放宽点只在"前缀"这一处：`Bearer` 之后的内容仍须逐字相等。
 *
 * # 测试方式
 *
 * `serverAuth` 会把 `util.makeLog` 当日志出口，这里打桩成空实现——被验证的
 * 比对逻辑与请求对象都没有被替换，所以不削弱本测试。这与
 * `bot-proxy.test.js` 的做法一致（那边也解释了 vitest 下 logger 的环境差异）。
 */

const { default: Bot } = await import("../../lib/bot.js")

describe("Bot.authValueMatches：令牌比对", () => {
  /** @type {InstanceType<typeof Bot>} */
  let bot

  beforeEach(() => {
    vi.spyOn(util, "makeLog").mockImplementation(() => {})
    bot = new Bot()
  })

  it("裸令牌逐字相等时通过", () => {
    expect(bot.authValueMatches("s3cret", "s3cret")).toBe(true)
  })

  it("**接受 `Bearer <令牌>`**（SnowLuma 就是这么发的）", () => {
    expect(bot.authValueMatches("Bearer s3cret", "s3cret")).toBe(true)
  })

  it("scheme 大小写不敏感、允许多个空格（HTTP 的 scheme 本身不区分大小写）", () => {
    for (const value of ["bearer s3cret", "BEARER s3cret", "Bearer   s3cret", "Bearer\ts3cret"])
      expect(bot.authValueMatches(value, "s3cret"), value).toBe(true)
  })

  it("令牌本身仍然逐字相等——不是放宽成'带 Bearer 就过'", () => {
    expect(bot.authValueMatches("Bearer wrong", "s3cret")).toBe(false)
    expect(bot.authValueMatches("Bearer s3cre", "s3cret")).toBe(false)
    expect(bot.authValueMatches("Bearer s3cretx", "s3cret")).toBe(false)
    // 不能靠"令牌后面再接一段"绕过
    expect(bot.authValueMatches("Bearer s3cret extra", "s3cret")).toBe(false)
    // 也不能反过来（配置里是 Bearer 时，裸令牌不该过）
    expect(bot.authValueMatches("s3cret", "Bearer s3cret")).toBe(false)
  })

  it("空值 / 非字符串一律不通过（不因为类型怪就放行）", () => {
    for (const value of [undefined, null, "", 123, {}, ["s3cret"], true])
      expect(bot.authValueMatches(value, "s3cret"), String(value)).toBe(false)
  })

  it("配置里的令牌为空串时不通过（空令牌等于把门打开，必须挡住）", () => {
    // 注意 `serverAuth` 在 `cfg.server.auth` 整体为空时是**直接放行**的（那是
    // 刻意的"未启用鉴权"语义）；这里只保证"某个键的值是空串"不会变成万能钥匙
    expect(bot.authValueMatches("", "")).toBe(true)
    expect(bot.authValueMatches("Bearer ", "")).toBe(true)
    expect(bot.authValueMatches("随便什么", "")).toBe(false)
  })
})
