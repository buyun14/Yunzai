/**
 * `wsConnect` 的适配器名解析（回归测试）。
 *
 * # 这个 bug 长什么样
 *
 * `serverAuth` 支持用**查询参数**过鉴权（`req.query[i] === cfg.server.auth[i]`），
 * 而 `wsConnect` 会先把 `req.query` 解出来给鉴权用。但取适配器名时用的是
 * `req.url.split("/")[1]`——`req.url` **带查询串**，于是拿到
 * `OneBotv11?Authorization=xxx`，`path in this.wsf` 判定失败 → **404**。
 *
 * 后果特别隐蔽：鉴权其实**通过了**，客户端却只看到握手失败（404/401 都表现为
 * "连不上"）；而且这恰好把"用 URL 带令牌"这条框架本来就支持的路堵死，
 * 于是 `server.auth` 一填、所有 OneBot 适配器都连不上（实测 SnowLuma）。
 *
 * # 为什么这里用"复刻解析规则"而不是直接调 wsConnect
 *
 * `wsConnect` 挂在 `Yunzai` 实例上，构造它会拉起整个宿主（express、chokidar、
 * redis…），不适合放进单测。而真正的风险点只有一行**字符串解析**，
 * 这里把那一行按同样的规则复刻一遍并钉住期望值。
 *
 * ⚠️ 这**不能替代真机验证**：复刻出来的解析即使写错也照样通过。所以同一层级上
 * 还有一次真机握手验证（`scripts/e2e/ws-auth.mjs`，由 `pnpm e2e:ws` 跑），
 * 那一个才是真正证明"带令牌能升到 101"的。
 */

import { describe, expect, it } from "vitest"

/**
 * 与 `lib/bot.js` 的 `wsConnect` 保持一致的适配器名解析。
 *
 * @param {string} url `req.url`（含查询串）
 * @returns {string} 适配器名（第一段路径）
 */
function adapterPathOf(url) {
  return url.split("?")[0].split("/")[1]
}

describe("wsConnect 的适配器名解析", () => {
  it("不带查询串时取第一段路径", () => {
    expect(adapterPathOf("/OneBotv11")).toBe("OneBotv11")
    expect(adapterPathOf("/Satori")).toBe("Satori")
    expect(adapterPathOf("/OneBotv11/")).toBe("OneBotv11")
  })

  it("**带查询串时也要取到干净的适配器名**（这次修的 bug）", () => {
    // 修复前这里会得到 "OneBotv11?Authorization=xxx" → 404
    expect(adapterPathOf("/OneBotv11?Authorization=secret")).toBe("OneBotv11")
    expect(adapterPathOf("/OneBotv11?Authorization=a&other=b")).toBe("OneBotv11")
  })

  it("区分大小写（适配器名是精确匹配）", () => {
    // `/onebotv11` 不是 `/OneBotv11`：`wsf` 的键是适配器自己声明的 path
    expect(adapterPathOf("/onebotv11")).toBe("onebotv11")
    expect(adapterPathOf("/onebotv11")).not.toBe("OneBotv11")
  })

  it("没有适配器名时也不会误命中（空串不可能是 wsf 的键）", () => {
    // `"/"` 切出来是空串、`""` 切出来是 undefined，两者都不该命中任何适配器
    for (const url of ["/", "", "/?Authorization=x"]) {
      const path = adapterPathOf(url)
      expect(path === "" || path === undefined, JSON.stringify(url)).toBe(true)
      // 关键：`in` 判定必须失败（`""` 与 `undefined` 都不会是合法的适配器名）
      expect(path in { OneBotv11: [] }, JSON.stringify(url)).toBe(false)
    }
  })
})
