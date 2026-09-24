#!/usr/bin/env node
/**
 * WebSocket 鉴权的真机验证：适配器**带令牌能不能握手成功**。
 *
 * 为什么需要它
 * ------------
 * `serverAuth` 支持用查询参数过鉴权（`?Authorization=<token>`），而 `wsConnect`
 * 取适配器名时曾经**没切掉查询串**，于是 `path in this.wsf` 判定失败 → 404。
 *
 * 这个 bug 的两个特点决定了单测兜不住：
 * 1. 它只在 `server.auth` **非空**时才显形（空 auth 时直接放行，永远走不到）；
 * 2. 鉴权其实**通过了**，客户端只看到握手失败——404 与 401 在客户端眼里都是
 *    "连不上"，日志里也不显眼。
 *
 * `tests/unit/web/ws-adapter-path.test.js` 把那行解析规则钉住了，但那是**复刻**
 * 出来的解析，解析写错也照样通过。真正能证明"带令牌升到 101"的只有这里。
 *
 * 用法（需要宿主已经在跑）
 * ------------------------
 * ```bash
 * node scripts/e2e-ws-auth.mjs --token <你的 server.auth 里的值> [--url ws://127.0.0.1:2536/OneBotv11]
 * ```
 *
 * 退出码：0 全通过；1 有断言失败；2 参数不对/连不上。
 */
import http from "node:http"

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ token: string, url: string }} 参数
 */
function parseArgs(argv) {
  const out = { token: "", url: "ws://127.0.0.1:2536/OneBotv11" }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--token") out.token = argv[++i] ?? ""
    else if (argv[i] === "--url") out.url = argv[++i] ?? out.url
  }
  return out
}

const { token, url } = parseArgs(process.argv.slice(2))
if (!token) {
  console.error("缺 --token（就是 config/config/server.yaml 里 server.auth 的值）")
  process.exit(2)
}

const target = new URL(url)
const KEY = Buffer.from("0123456789abcdef").toString("base64")

/**
 * 发一次 WS 升级握手，返回状态码。
 *
 * 101 = 握手成功；401 = 被鉴权挡住；404 = 鉴权过了但没有这个适配器（**就是那个 bug**）。
 *
 * @param {string} pathname 路径（含查询串）
 * @param {Record<string, string>} [extraHeaders] 额外请求头
 * @returns {Promise<number>} 状态码，连不上时返回 -1
 */
function handshake(pathname, extraHeaders = {}) {
  return new Promise(resolve => {
    const req = http.request({
      host: target.hostname,
      port: Number(target.port || 80),
      path: pathname,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": KEY,
        "Sec-WebSocket-Version": "13",
        // 伪装成 OneBot 客户端，走的是与 SnowLuma 完全一样的握手
        "User-Agent": "OneBot/11",
        "X-Self-ID": "10000",
        "X-Client-Role": "Universal",
        ...extraHeaders,
      },
    })
    req.on("upgrade", res => {
      resolve(res.statusCode ?? 101)
      req.destroy()
    })
    req.on("response", res => {
      resolve(res.statusCode)
      req.destroy()
    })
    req.on("error", () => resolve(-1))
    req.end()
  })
}

const adapterPath = target.pathname
const cases = [
  {
    label: "不带令牌（应被拒）",
    path: adapterPath,
    expect: 401,
    why: "空令牌必须过不去，否则鉴权形同虚设",
  },
  {
    label: "裸令牌做请求头（应握手成功）",
    path: adapterPath,
    headers: { Authorization: token },
    expect: 101,
    why: "配置里的令牌原样放在头里，这是最直接的用法",
  },
  {
    label: "**`Bearer <令牌>` 做请求头（SnowLuma 实际发的，应握手成功）**",
    path: adapterPath,
    headers: { Authorization: `Bearer ${token}` },
    expect: 101,
    // 这一条是最容易漏的：SnowLuma 自动加 Bearer 前缀，而全等比较会让它
    // 无论用头还是用查询参数都过不去，日志里只有一句"鉴权失败"
    why: "SnowLuma 自动给 Authorization 加 `Bearer ` 前缀；不接受它就连不上",
  },
  {
    label: "带 ?Authorization=<令牌>（应握手成功）",
    path: `${adapterPath}?Authorization=${encodeURIComponent(token)}`,
    expect: 101,
    why: "带对了令牌却拿不到 101，说明适配器名解析把查询串也算进去了（历史上就是这样 404 的）",
  },
  {
    label: "带 ?Authorization=Bearer%20<令牌>（应握手成功）",
    path: `${adapterPath}?Authorization=${encodeURIComponent(`Bearer ${token}`)}`,
    expect: 101,
    why: "查询参数里带上 Bearer 前缀同样要认",
  },
  {
    label: "带小写 ?authorization=<令牌>（应被拒）",
    path: `${adapterPath}?authorization=${encodeURIComponent(token)}`,
    expect: 401,
    why: "查询参数名要与 server.auth 的键名**完全一致**，小写不匹配",
  },
  {
    label: "带错误令牌（应被拒）",
    path: `${adapterPath}?Authorization=definitely-wrong`,
    expect: 401,
    why: "错令牌必须过不去",
  },
]

let failures = 0
console.log(`目标：${url}`)
console.log("")
for (const item of cases) {
  const code = await handshake(item.path, item.headers)
  const ok = code === item.expect
  if (!ok) failures++
  const label = ok ? "  ok  " : " FAIL "
  console.log(`${label} ${code}  (期望 ${item.expect})  ${item.label}`)
  if (!ok) console.log(`        ↳ ${item.why}`)
}

console.log("")
if (failures) {
  console.log(`### 有 ${failures} 项失败`)
  process.exit(1)
}
console.log("### 全部通过")
