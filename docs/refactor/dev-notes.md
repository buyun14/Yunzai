# 开发笔记：工具、环境与陷阱

> 各分册写的是「要改什么、怎么验收」；**这份写的是「改的时候会被什么咬到」**。
>
> 收录判据：① 这条知识会让人少走一次弯路；② 它不属于任何一份分册的主题。
> 属于某个阶段的内容不要放这里——状态与结论只写在分册里。

## 1. 命令行

- 命令一律写成 `pnpm -C <仓库绝对路径> …` 或绝对路径。有些执行环境会**剥掉命令开头的
  `cd "..."`**——`cd` 看起来执行了，其实没有，后续命令跑在别的目录里。
- 不要把可能进入交互的命令接管道（如 `| Select-Object`）：管道会把提示藏起来，
  执行环境就无法判断"它在等输入"。要过滤输出就先写文件再读。
- **不要把长跑进程接进 `Select-Object -First N`**：凑满 N 条时 PowerShell 会掐断管道，
  `pnpm` 被杀而 node 子进程留下，而它的 stdout 已经是断的。那个实例**表面仍在监听端口、
  一部分接口正常，某些接口却永远不响应**（实测 `/api/v1/config` 挂到客户端超时，
  而 `/ready` / `/status` / `/plugins` 都正常）。这种"半死的进程"会把排查方向带偏——
  代码、依赖、路由元一查一遍，而重新干净启动就正常了。
  正确做法是重定向：`pnpm -C <仓> app *> .git/TMP_RUN.log`，之后再读文件。
- 需要多行脚本时写临时文件（如 `.git/TMP_*.mjs`）再 `node` 它。PowerShell 里 `&&` 是
  合法的链式运算符，出现在 `node -e "…"` 里会被它吃掉并报 `SyntaxError`。
- 删代码时**不要按行号删**：先按内容定位，算完区间**自下而上**删，删完立刻 `node --check`。
  终端回显在折行处会插入空格，照抄长行当锚点必然匹配不上。

## 2. 提交

- 提交信息正文里**不要用 `##` 标题**——commitlint 会把它当成 footer，报
  `footer-leading-blank` 警告。
- `lint-staged` 会在提交时对暂存文件补 `prettier --write` 与 `eslint`。所以"提交前
  `pnpm lint` 红"未必代表提交后也红（尤其对刚由脚本/测试**生成**的文件，如
  `baseline-snapshots.json`）。**但别把没查清的红当成噪音**：先看是哪个文件、谁生成的。
- CI 的步骤是**顺序执行**的：某一步失败，后面几步不会执行。所以 `CI` 挂在 `typecheck`
  时，四条腿上的 `pnpm test` 其实没跑过——不能据此认为测试通过。

## 3. 查 CI 状态

`gh` 已安装但**未登录**（不要跑 `gh auth login`：它是交互式的且涉及密钥）。
仓库是公开的，直接用免鉴权 REST：

```powershell
$h = @{ "User-Agent" = "pwsh" }
(Invoke-RestMethod "https://api.github.com/repos/buyun14/Yunzai/actions/runs?per_page=8" -Headers $h).workflow_runs |
  ForEach-Object { "{0,-8} {1,-11} {2,-9} {3}" -f $_.name, $_.status, "$($_.conclusion)", $_.head_sha.Substring(0,7) }

# 某个运行里的各 job：把 runs 换成 /actions/runs/<id>/jobs
```

## 4. 本地绿 ≠ CI 绿

**`package.json` 的 `imports` 把 `#miao` 映射到 `plugins/miao-plugin/`，而它是 gitignore 的。**
装了插件的机器能解析到文件，干净克隆与 CI 报 TS2307——同一句 `pnpm typecheck` 在两处结论不同。
修法与复现方式见 `baseline/static-analysis.md` §3.6；类型声明在 `types/globals.d.ts`。

同类风险：任何读 `plugins/miao-plugin/**`、`config/**`、`data/**` 的代码，在 CI 上都走另一条分支。

因此验收必须是「**干净克隆跑全部四个门**」，而不是只跑 `pnpm test`：

```powershell
$dst = "$env:TEMP\yz-gate-check"
git clone E:\ProjectCollection\2026_9\Work\Yunzai $dst
pnpm -C $dst i
pnpm -C $dst lint; pnpm -C $dst lint:eslint; pnpm -C $dst typecheck; pnpm -C $dst test
```

## 5. 覆盖率清单要跟着新模块走

`vitest.config.js` 的 `CORE_MODULES` 是**白名单**：新模块不加进去就等于没被统计——
覆盖率可以掉到 0 而 CI 照旧全绿。已经漏过三次（阶段 4 的 `lib/message` / `lib/adapter`、
阶段 5 的 `lib/config/`）。清单位置、判据与"哪些目录不能加"见 `03-engineering.md` §3.4.1。

## 6. `app.js` 顶层的控制流单测覆盖不到

`switch (process.argv[2])` 的各个 CLI 分支只在真跑时才执行。曾经因此漏掉一个 bug：
`process.stdout.write(text, () => process.exit())` 的回调是异步的，`break` 之后控制流继续
走到 `new Bot()`——"只读报告"顺手把整个 bot 启了起来，新实例还会因端口占用向**正在运行的
实例**发 `/exit`。

**改 `app.js` 之后必须真跑一次那条命令，并确认端口没被监听。**

## 7. 真机验证的纪律

- **不要在仓库里写真实账号、群号、token**（本仓公开）。测试环境信息留在会话记忆里。
- **归因只取本侧日志**（`[开始处理]` / `[完成N]` / `发送…`），不要用"群里出现了什么内容"
  当判据：测试群里可能挂着第二个同类账号，会把噪声看成"镜像"
  （见 `baseline/startup.md` O3）。
- 起本地测试实例前**先探测端口 2536 是否空闲**：`Bot.serverEADDRINUSE()` 会向占用者发
  `/exit`，把正在运行的实例挤掉。
- `pnpm app stop` 的**退出码是 1**，与崩溃无法区分，只能用日志判断。

## 8. 文档即状态

状态只写在文档里——不写在提交信息里，也不写在聊天记录里。改完一个阶段同步三处：

| 位置 | 同步什么 |
|---|---|
| `PLAN.md` §9 进度总表 | 勾选 + 一句话结论 |
| 对应分册 | 顶部状态标注、`> 落地情况（日期）` 块、§ 验收清单勾选 |
| `99-compat-and-migration.md` | 新增/淘汰 L1 适配与 BCR 编号；**偏离原计划的地方必须写清偏离了什么** |

勾选验收项要附**证据**（文件路径 / 命令 / 实测输出）。没有证据的勾选等于把"没人核实过"
伪装成"已验证过"，比不勾更危险。

### 8.1 在制品也要落到文档里

一次改动没做完就中断（换会话、换人、换天）时，**在制品状态写进对应分册**，
不要只留在会话记忆里：

```markdown
> **在制品（2026-09-24，未提交）**：`loader.js` 已删完、`legacy.test.js` 已改完；
> 还差 `shadow.test.js` 的旧侧用例。
> **恢复成绿的命令**：`git checkout -- lib/plugins/loader.js tests/unit/message/legacy.test.js`
```

格式随场景，但三件事必须有：**已做到哪、还差什么、怎么退回去**。
最后一条最重要——中断时的代码往往是红的，下一个人需要一条确定的复活路径。

反向也成立：**发现文档与代码不一致时，先修文档**。一份过时的进度表会让下一个人
（或下一次会话）基于错误前提做决策。

## 9. `cfg.<名字>` 是**文件**，不是嵌套键

`lib/config/config.js` 的 Proxy 把 `cfg.X` 映射到 `config/config/X.yaml` 与
`config/default_config/X.yaml`（浅合并，用户优先）。因此：

- 新增配置项要么放进**已有的** yaml（如 `server.webui.enable` → `config/config/server.yaml`），
  要么新建一个**同名**的 yaml 文件；
- 写 `cfg.webui.enable` 而只在 `server.yaml` 里放了 `webui:` 段，会去找不存在的
  `webui.yaml`，读到 `undefined` —— **静默失效，没有任何报错**（阶段 6 的 WebUI 开关
  头一版就是这么写的，真跑才看出来）；
- 浅合并的后果：用户在 `config/config/server.yaml` 里写了 `webui:` 段，
  就会**整体覆盖**默认的那个对象，不会逐键合并。新增子键时必须把这一点写进注释；
- 还有一个坑：**裸 node 脚本里读 `cfg` 会在解析失败时炸** —— `getYaml` 的 catch 里用了
  全局 `Bot.makeLog`。想单独看配置就写最小脚本 + 直接 `YAML.parse`，或者干脆真启动一次。

## 10. 类字段初始化里的 TDZ：异常被吞，整条 `.use` 链静默少挂一层

**症状**：`/dashboard/` 与 `/api/v1/*` **全部挂起**到客户端超时（不是 4xx/5xx，是连响应头都没有），
而启动日志一切正常（`WebUI 已挂载` 照打）。单测全绿——因为单测是**自己拼**中间件链的。

**根因**是在**类字段初始化表达式**里引用了正在初始化的变量：

```js
express = (() => {
  const app = Object.assign(express(), { skip_auth: [], quiet: [] })
  return app.use(WebUI.frontend.bind(WebUI, { skipAuth: app.skip_auth })) // ← app 处于 TDZ
})()
```

`app.skip_auth` 在 `const app = …` 的**同一个表达式**里求值 → `ReferenceError`；
而这个异常在字段初始化里被**吞掉**，于是 `.use(...)` 那一层从未注册。
请求走到那里没有下一层、也没有答复，只能挂到超时。

**正确写法**是把 app 先赋给一个已初始化完的局部变量，再用它：

```js
const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(WebUI.earlyProbe.bind(WebUI))
app.use(WebUI.frontend({ skipAuth: app.skip_auth }))
return app.use(/* 其余各层 */)
```

**排查这类问题的教训**（比坑本身值钱）：

1. **单测拼链 ≠ 真实链**。`tests/` 里的 `hostApp()` 手工按顺序挂中间件，
   所以它能绿；`lib/bot.js` 的真实字段初始化没被任何单测覆盖。
   凡是"改 `lib/bot.js` 的中间件链"的改动，**必须真启一次**再收工。
2. **`console.log` 写进被重定向的管道是块缓冲的**：进程还活着时一条都读不到，
   于是「日志文件里没有我的调试输出」会被误读成「这行代码没执行」——
   我为此绕了很久。调试长跑宿主请用**同步写 `process.stderr`**，或走 `logger`（它会 flush）。
3. **看到"中间件没被调用"先怀疑注册**，而不是分发：express 5 不再暴露
   `layer.regexp`，用 `stack[i].name` / `layer.path` 判断挂载情况更可靠；
   直接 `layer.handle(fakeReq, fakeRes, next)` 手工调用**会绕过真实分发**，结论不可信。
4. 验证宿主时**先确认端口空闲、再核对监听者 PID 就是本次启动的那个进程**：
   `Bot.serverEADDRINUSE()` 会向占用者发 `/exit`，残留实例会让"改动没生效"的假象持续很久。

## 11. `app.use("/前缀", handler)` 与挂在根上自己判断前缀

WebUI 的前端中间件（`lib/web/server.js` 的 `mountFrontend`）最终是**挂在根上**、
自己比对 `UI_PREFIX` 的，与 `earlyProbe` 同一个做法。两个原因：

- 挂在 `/dashboard` 上时 `req.url` 会被 express 剥掉前缀，看起来更省事，
  但**入口文档与 assets 的免鉴权判断必须发生在 `serverAuth` 之前**，
  而"挂在哪个路径"与"放行哪一类请求"是两件独立的事；纠缠在一起会让
  「只放行入口文档、不放行整个 `/dashboard`」这个安全边界难以表达；
- 更重要的是：**`skip_auth` 是前缀匹配**（`serverAuth` 用 `originalUrl.startsWith`），
  把 `/dashboard` 整个放进 `skip_auth` 会连适配器挂在它下面的路由一起免鉴权。
  所以入口文档走"自己认形状"、assets 走 `skip_auth` 前缀，两者分开。

## 12. 自写的 SVG 图标组件**必须显式给尺寸**

`dashboard/src/plugins/vuetify.ts` 的 `MdiSvgIcon` 是自写的（Vuetify 3.13 不导出
`VSvgIcon`）。踩过两次，症状一样、原因不同：

| 写法 | 结果 |
|---|---|
| 只给 `viewBox` | 图标变成 **300×150 的巨大图形**，把表格整行顶开 |
| `width="100%"` | **没用**——100% 解析回父级的 auto，等于没给 |
| `width="1em"` | ✅ 尺寸跟着字号走，`size="small"` / `x-small` 照常生效 |

根因：`viewBox` 定义的是**坐标系**而不是尺寸；没有尺寸的 `<svg>` 是替换元素，
浏览器按默认 `300×150` 渲染，反而把父级 `.v-icon` 的 `1em` 撑开。

⚠️ **TypeScript 与 `vite build` 都不会报这个**，只能靠看截图。所以改前端之后
一定要截图（见 §7 的真机验证纪律），"构建通过"对渲染问题零证明力。

## 13. headless Chrome + puppeteer **完不成下载**

验证"导出日志"这类功能时，不要断言"文件落盘了"——在这个组合下**永远不成立**。

实测（用 CDP 的 `Browser.setDownloadBehavior` + `eventsEnabled`）：

```
对照组（一个最小 blob，完全不经过我们的代码）：
  Browser.downloadWillBegin  control-group.txt
  Browser.downloadProgress   inProgress ×5  →  canceled
  下载目录：（空）
```

连对照组都 `canceled`，所以这是环境限制、不是功能问题。
**能验证的是这两条**（合起来足以证明"点导出会正确产出并交付内容正确的文件"）：

1. CDP 的 `Browser.downloadWillBegin` 事件 —— 证明浏览器确实发起了下载、文件名正确；
2. 拦 `URL.createObjectURL` 把 blob 文本读出来 —— 证明内容非空且格式正确。

另外两条同类的坑，都踩过：

- **`URL.revokeObjectURL` 不能紧跟在 `a.click()` 之后**：同步 revoke 会让下载取不到
  数据，而且**不报错**，表现为"点了导出、什么都没发生"。要推迟（这里用 10 秒）。
- **别用 DOM 行数当"导出条数"的期望值**：日志视口是限高滚动的，DOM 里只有几十个
  `.log-line`，而"导出过滤结果全量"是几百行。断言要写成 `导出条数 ≥ DOM 行数`。

## 14. 填上 `server.auth` 会让**所有适配器连不上**（曾有内核 bug，已修）

### 症状

```
[ERRO][ws://127.0.0.1:2536/OneBotv11 <≠ ::ffff:127.0.0.1:36827-…] HTTP GET 请求
      Authorization 鉴权失败 { headers: { upgrade: 'websocket', 'x-self-id': …, … } }
```

### 两个叠加的原因

**① `serverAuth` 是站点级的。** 空 `auth` 时它直接放行（`if (!cfg.server.auth …)
return req.next?.()`），一填上就**所有路径**都要令牌——包括适配器回连的
`/OneBotv11`。所以"只是想开个面板"与"给 HTTP 服务加门禁"是同一件事；面板要求
非空 `auth` 才挂载，因此绕不开，启用前要想清楚。

**② 框架本来就支持用查询参数带令牌，但 `wsConnect` 把它堵死了**（已修）。

`serverAuth` 明确支持 `req.query[i] === cfg.server.auth[i]`，`wsConnect` 也确实先把
查询串解析好放进 `req.query`。但取适配器名时用的是：

```js
const path = req.url.split("/")[1]   // 修复前
```

`req.url` **带查询串**，于是 `/OneBotv11?Authorization=xxx` 解析成
`OneBotv11?Authorization=xxx`，`path in this.wsf` 判定失败 → **404**。

⚠️ 隐蔽之处在于**鉴权其实是过了的**：客户端只看到握手失败，而 404 与 401 在客户端
眼里都是"连不上"；服务端那边也只是一句不太起眼的「WebSocket 处理器 … 不存在」。
真实后果是 **`server.auth` 一填，所有 OneBot 适配器集体断开**，而框架文档里
"用 URL 带令牌"这条路正好被堵死。

修法：先按 `?` 切分（`lib/bot.js` 的 `wsConnect`）。

### 怎么验证

```bash
pnpm e2e:ws --token <server.auth 里的值>     # 需要宿主已在跑
```

四次握手，关键的一条是"带对了令牌必须升到 **101**"——只看 401/404 分不清
"令牌不对"与"适配器名解析错"，而这正是当初漏掉它的原因。

`tests/unit/web/ws-adapter-path.test.js` 也钉住了那行解析规则，但它是**复刻**的，
解析写错也照样通过，所以真机那条不能省。

### SnowLuma 侧的配置

**改完 `Bearer` 支持之后，SnowLuma 什么都不用改**——它保持原来的
`ws://127.0.0.1:2536/OneBotv11` 就能连上（见下面 §15）。

（历史上曾需要把地址写成 `ws://127.0.0.1:2536/OneBotv11?Authorization=<令牌>`；
`Bearer` 支持落地后这条不再必要，但那条路仍然可用。）

## 15. SnowLuma 连不上：它**自动给 Authorization 加 `Bearer ` 前缀**

### 症状

配置看起来完全正确（`server.auth` 里的令牌一字不差），但每次连上都报：

```
[ERRO][ws://127.0.0.1:2536/OneBotv11 <≠ …] HTTP GET 请求 Authorization 鉴权失败 {
  headers: { …, authorization: 'Bearer c245524534adc8bf3f895140066548f1e0355df87552cfcf' }
}
```

**关键在最后那一行**：SnowLuma 发的是 `Bearer ` + 令牌，而 `serverAuth` 是拿整个
值做**全等**比较的：

```js
req.headers[i.toLowerCase()] === cfg.server.auth[i]
// "Bearer c245…" !== "c245…"  → 一直失败
```

于是它**用请求头不行、用查询参数也不行**（`?Authorization=Bearer%20…` 同样不匹配），
而日志只给一句"鉴权失败"，看起来像令牌填错了——排查方向很容易被带偏。

### 修法

`serverAuth` 的比对改为走 `Bot.authValueMatches()`：全等之外，额外接受标准的
`Bearer <令牌>` 形式（scheme 大小写不敏感、允许多个空格），**`Bearer` 之后的内容
仍须逐字相等**，所以没有削弱鉴权。

反向也刻意**不**要求配置里写成 `Bearer xxx`：宿主自己发出去的 `/File/...` URL 带的是
**裸令牌**（见 `fileToUrl`），那样自己发的 URL 又认证不了。放宽点只在前缀这一处。

### 怎么验证

```bash
pnpm e2e:ws --token <server.auth 里的值>
```

七次握手，其中两条是这次的关键：`Bearer <令牌>` 做请求头、以及
`?Authorization=Bearer%20<令牌>`。另有 `tests/unit/bot-auth.test.js` 覆盖比对本身
（含"`Bearer s3cret extra` 不能过"这种前缀拼接的绕过尝试）。

⚠️ 这类"看起来像令牌错了、其实是格式不匹配"的问题，只对着配置反复核对是查不出来的
——必须把**请求实际带来的那个值**打出来看（这次的 `authorization:` 一行就是答案）。

