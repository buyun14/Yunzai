# 阶段 6：WebUI 与 API 契约

> 上游：[`05-persistence-config.md`](./05-persistence-config.md) · 下游：[`07-ai-capabilities.md`](./07-ai-capabilities.md)
> 参考实现：AstrBot `dashboard/`、`astrbot/dashboard/api/{router,auth}.py`、`astrbot/dashboard/server.py`、`openspec/openapi-v1.yaml`

## 1. 目标

提供运维界面（状态、插件、配置、日志），并让 HTTP API 有稳定契约，供第三方与插件页面消费。

> **状态（2026-09-24）：后端已完成；`dashboard/` 前端已委托给另一个 agent。**
> §3.3 的安全四条（含两处偏离）、启动期就绪语义、五个接口（含 SSE 日志流）、
> `docs/openapi.yaml` 契约与一致性测试均已落地并真机验证。
> **接手前端请直接看 §7 的交接单**（范围、边界、起步步骤、已知坑、完成时要同步的文档）。
> 阶段 5 遗留的「宿主配置 schema 化」（`config/host.schema.js`）与本节 v2 的配置编辑合并做（同一个同构校验器）。

---

## 2. 现状

### 2.1 已经有一个 HTTP 服务（被低估的基础）

`lib/bot.js` 里的 express 应用已经具备完整的服务骨架：

| 能力 | 实现 |
|---|---|
| 端口与开关 | `config/default_config/server.yaml`：`url`、`port: 2536`、`redirect`、`auth`、`https` |
| 中间件链 | `serverAuth` → `compression()` → `/status` → `urlencoded/json/raw/text` → `serverHandle` → `/exit` → `/File` |
| `/status` | 返回 `process.report.getReport()`，并把 IPv4 正则打码 |
| `/exit` | 仅允许本机（`::1` / `::ffff:127.0.0.1`） |
| `/File` | 文件下载 |
| 鉴权 | `cfg.server.auth` 是「请求头名或查询参数名 → 令牌」的映射，任一不匹配即 401；`req.app.skip_auth` 前缀白名单可跳过；`req.app.quiet` 控制该路径的日志级别 |
| WebSocket | `Bot.wsf[path]` 是「路径 → 处理器数组」，适配器自行注册（`OneBotv11.js:1547`、`ComWeChat.js:574`、`GSUIDCore.js:327`、`OPQBot.js:388`） |
| 插件挂路由 | 适配器可直接用 `Bot.express.post(path, …)`（`plugins/adapter/Milky.js:100`） |

**必须注意的语义**：`serverAuth` 在 `this.stat.online !== 2` 时会 `once("online", …)` 把请求**挂起**，而不是返回错误。启动期到达的请求会一直等待。WebUI 必须处理这一点（否则表现为"页面永远转圈"）。

### 2.2 `lib/tools/web.js` 不是运维面板

`npm run web` 起在 8000 端口，用 `express-art-template` 渲染 `temp/ViewData/` 下的截图数据，用途是**模板调试**，与运行时状态无关。

### 2.3 缺口

| # | 缺口 | 后果 |
|---|---|---|
| 1 | 无状态可视化 | 只能 `curl /status` 看一份原始报告 |
| 2 | 无插件管理 | 启停/查看插件只能改配置 + 重启 |
| 3 | 无配置编辑 | 只能手改 yaml |
| 4 | 无日志查看 | 只能看终端 |
| 5 | 无 API 契约 | 第三方集成靠读源码 |
| 6 | **默认 `auth` 为空** | `server.yaml` 的 `auth:` 默认无值，此时 `serverAuth` 直接放行——任何把端口暴露到公网的实例都是完全敞开的 |

---

## 3. 设计

### 3.1 网络层：复用现有服务，不新起进程

| 路径 | 内容 |
|---|---|
| `/dashboard` | SPA 静态资源（构建产物） |
| `/api/v1/*` | JSON API |

`/status`、`/exit`、`/File` 以及各适配器注册的路径**一律不动**。`skip_auth` / `quiet` 保持现有语义，WebUI 自行向 `Bot.express.skip_auth` 追加需要的静态资源前缀（如 `/dashboard/assets`）。

不采用 AstrBot 那样的"独立 ASGI 服务 + 独立端口"架构——Yunzai 的 express 服务已在运行且已有鉴权与 WebSocket 基础设施，另起服务会带来两套鉴权与两个端口。

### 3.2 契约先行

借鉴 AstrBot 的核心做法：**单一 OpenAPI 规范同时驱动前端客户端与后端文档**（其 `openspec/openapi-v1.yaml`）。

| 项 | 做法 |
|---|---|
| 契约文件 | `docs/openapi.yaml` |
| 前端客户端 | `@hey-api/openapi-ts` 生成到 `dashboard/src/api/generated/` |
| 一致性保障 | CI 中执行生成命令后 `git diff --exit-code`，契约与代码不同步即失败 |
| 手写外观层 | `dashboard/src/api/v1.ts` 包一层（区分手写与生成，同 AstrBot） |

> **落地情况（2026-09-24）：契约文件已落地，但一致性保障换了做法。**
>
> `docs/openapi.yaml` 已写完（5 个接口 + 鉴权 + 错误形状 + 全套 schema）。
>
> **偏离：没有引入 `@hey-api/openapi-ts`，也没做「生成后 `git diff --exit-code`」。**
>
> 那个方案防的是**契约与生成物**漂移，防不住真正的风险：**契约与服务器漂移**。
> 而且生成物的落地位置（`dashboard/src/api/generated/`）在前端还不存在时无处可放，
> 提前引入该 devDep 就是为不存在的需求付成本（`AGENTS.md` 规则 5）。
>
> 换成更直接的检查：`tests/unit/web/openapi.test.js` 解析契约，逐项对着
> **真实路由**与**真实响应体**比——路径与方法双边一致、`200` 响应的顶层字段
> 双向一致（契约写了却没返回、返回了却没写，都红）、嵌套对象同样逐字段核、
> 枚举值与实现一致。它跑在 `pnpm test` 里，因此同样是 CI 阻塞项。
>
> 前端落地后可以把「生成 + diff」叠加上来，两者互补：一个守契约↔服务器，
> 一个守契约↔客户端。
>
> 顺带改了一处接口形状：单文件从 `?file=x.yaml` 改成路径参数 `/config/{name}`。
> 同一个路径两种响应体在 OpenAPI 里只能写成 `oneOf`，生成客户端会得到一个联合类型；
> 前端还不存在，此时改比以后改便宜。
>
> 真机验证（2026-09-24，临时改配置、验完已还原）：
>
> ```
> GET /api/v1/config                        → 200（9 个文件）
> GET /api/v1/config/server.yaml            → 200 status=both redacted=["auth"] auth="***"
> GET /api/v1/config/..%2F..%2Fpackage.json → 400 bad_request（URL 解码后的穿越也被白名单拦住）
> GET /api/v1/config/whatever.yaml          → 404 not_found
> GET /api/v1/config/server.yaml（不带令牌）  → 401
> ```
>
> ⚠️ 这一轮把`dev-notes.md` §1 的另一条坑坐实了：把长跑进程接进
> `Select-Object -First 1` 之后，PowerShell 会在凑满一条时掐断管道，`pnpm` 被杀而 node
> 子进程留下——那个实例仍在监听端口、`/ready` 与 `/status` 都正常，**只有 `/config`
> 永远不响应**。差一点就去查 `collectDiff()` 的死锁了（在隔离环境里跑它只要 34ms）。

### 3.3 安全（必须与功能同期上线，不能"以后再加"）

- [ ] **启用 WebUI 时强制要求 `cfg.server.auth` 非空**。为空时：`/dashboard` 与 `/api/v1/*` 不挂载，并在启动日志中明确告知如何配置。绝不能静默放开。
- [ ] 确认并显式配置监听地址，默认仅 `127.0.0.1`。
  现状 `server.yaml` 只有 `port`，绑定的网卡由 Node 默认行为决定，需显式化。
- [ ] 借鉴 `astrbot/dashboard/server.py` 的三个防护：
  1. **per-IP 令牌桶限流**（登录、重启、更新等敏感接口）；
  2. **按路径覆盖的请求体大小上限**（`_BODY_LIMIT_OVERRIDES` 模式）；
  3. **无 `Content-Length` 的 multipart 直接返回 411**，避免无界读取。
- [ ] 敏感操作（重启、更新、删除配置）要求二次确认字段，并在日志中记录来源 IP。

> **落地情况（2026-09-24）：本节前四条已落地。**
>
> | 文件 | 职责 |
> |---|---|
> | `lib/web/security.js` | per-IP 令牌桶限流、请求体上限、缺 `Content-Length` 的 multipart → 411 |
> | `lib/web/server.js` | 挂载门卫（`WebUI.mount`）、早期探针（`earlyProbe`）、`/api/v1/ready` |
> | `config/default_config/server.yaml` | 新增 `server.webui.enable`（默认 `false`）与 `server.address` |
>
> 设置项只增不改：`server.webui.enable` 不为 `true` 时 `mount()` 不挂载任何路径、**一条日志也不打**，
> 与改造前的行为逐字一致。旧用户的 `config/config/server.yaml` 里没有 `webui` 键，
> 因此升级后默认就是关闭的（失败向安全倒）。
>
> **偏离一：没有把默认监听地址改成 `127.0.0.1`。**
> 本节原写「默认仅 `127.0.0.1`」，实际改为新增 `server.address`（缺省 = 保持现状），
> 并在启用 WebUI 而 `address` 未配置时打一条 warn。理由：这个 HTTP 服务同时承担
> `/File` 的对外图片地址（`fileToUrl()` 产出的 URL 要能被 QQ 客户端取到）与适配器回调，
> 把默认监听面收窄到回环会**静默**弄坏它们——那比「面板可能被局域网访问」严重得多。
> 所以安全底线是「**启用必须配 auth**」，而不是「启用就假设只在本机」。
>
> **偏离二：早期探针必须插到 `lib/bot.js` 的中间件链首位。**
> 本节 §2.1 只说「启动期请求会挂起，WebUI 必须处理」，但没说怎么处理。
> 实际只能在 `serverAuth` **之前**挤进一层：它是链上第一个中间件，
> `stat.online !== 2` 时会把请求挂起等 `online` 事件，因此任何「就绪探针」都到不了终点。
> 这超出了「**不改**现有路由与鉴权逻辑」的字面范围（但只加了 1 行 `.use()`，
> 且未启用时是纯透传），因此单独记一笔。
>
> 另外两处分册没写、但必须定下来的决定：
>
> 1. **API 的错误处理挂在应用层，不放在 Router 内部。** express 只会把错误交给
>    「声明了 4 个形参的层」，而抛错的 body 解析器挂在路由之前，Router 内部的 4 参
>    处理器接不到它。挂上去的效果：全局 `express.json()` 的超限错误不再变成
>    宿主 `serverError()` 的那个**空的 200**，而是 413 JSON。
> 2. **未命中的 `/api/v1/*` 返回 JSON 404**，不落到宿主的 `302 → server.redirect`：
>    对 API 客户端来说「一个 HTML 跳转」比 404 难排查得多。
>
> 测试：`tests/unit/web/{security,server}.test.js` 共 36 个用例，全部走真实 HTTP
> （`node:http` 而不是 `fetch`——后者表达不了「不带 `Content-Length`」的 chunked 请求）。
> 其中一条特意写成断言**性质**而不是次数：限流的回填按真实时间走，
> 「第 61 次必被拦」在快机器上会假红。
>
> ⚠️ **真跳才发现的错（值得单独记一笔）**：最初把开关写成 `cfg.webui.enable`。
> `cfg.<名字>` 映射的是 `config/config/<名字>.yaml` 这个**文件**，而不是嵌套键，
> 所以它会去找一个不存在的 `webui.yaml`、读到 `undefined`——
> **面板会永不启用，而不报任何错**。现在有两条用例盯着这个形状
> （正确的 `cfg.server.webui.enable` 生效；写成顶层 `cfg.webui` 时不生效），
> 坑本身也写进了 `dev-notes.md` §9。
>
> **真机验证（2026-09-24）**：临时把 `config/config/server.yaml` 改成
> `webui.enable: true` 并配一个临时令牌，验完已还原（用户配置未被改动）。
>
> ```
> [MARK][  Server  ] 启动 HTTP 服务器 http://[::]:2536
> [MARK][   WebUI  ] WebUI 已挂载：/api/v1（鉴权头：Authorization）
> [WARN][   WebUI  ] server.address 未配置，HTTP 服务监听在 Node 的默认网卡上…
>
> GET /api/v1/ready  不带令牌 → HTTP 401
> GET /api/v1/ready  带令牌   → {"ready":true,"online":2,"uptime":10}
> GET /api/v1/nope   带令牌   → HTTP 404（JSON，而不是宿主的 302 跳转）
> ```
>
> 这次真跑是**必要**的：单测注入的是假配置，而"配置读不到"恰好是这类接线最典型的
> 失败方式（见上面的 ⚠️）——只有真读一次真实 YAML 才证明得了。同一轮也顺带确认了
> 新接口与既有鉴权是同一套（不带令牌照样 401）。

### 3.4 前端

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Vue 3 + Vite | 与 AstrBot 一致，经验可复用 |
| UI | Vuetify 3 | 同上；表单密集的管理界面收益明显 |
| 状态 | Pinia | 同上 |
| 路由 | vue-router | 同上 |
| 目录 | `dashboard/src/{api,components,composables,layouts,router,stores,types,views,i18n}` | 与 AstrBot 同构，降低认知成本 |
| 构建产物 | **不提交到仓库**，由 CI 产出 | AstrBot 需要把 dist 打进 Python 包，Node 侧无此必要 |

`pnpm-workspace.yaml` 已在仓库中，`dashboard/` 直接作为 workspace 成员加入。

### 3.5 分三步上线

| 步 | 内容 | 前置依赖 |
|---|---|---|
| **v1 只读面板** | 状态总览（`/status` 结构化）、插件列表（阶段 1 的元数据）、配置查看、日志实时流 | 阶段 1 |
| **v2 配置编辑** | 表单由 schema 渲染；写入前后走同一个同构校验器（阶段 1 的 `lib/plugins/schema.js`） | 阶段 1、5 |
| **v3 插件页面** | 插件自带 `pages/`，受限 iframe + 插件用 `Bot.express` 注册自有 API | 阶段 7（可选） |

实时通道选择：

| 场景 | 通道 | 理由 |
|---|---|---|
| 日志流、统计流 | **SSE** | 单向、自动重连、无需额外握手；AstrBot 在 chat/logs 上也用 SSE |
| 命令执行（重启、更新） | 普通 POST + 轮询任务状态 | 不需要长连接 |
| 终端式交互 | WebSocket（复用 `Bot.wsf`） | 双向 |

---

## 4. 实现清单

新增：

| 路径 | 职责 |
|---|---|
| `lib/web/server.js` | 把 SPA 与 API 挂到 `Bot.express`；处理启动期挂起语义 |
| `lib/web/api/router.js` | `/api/v1` 路由汇总 |
| `lib/web/api/status.js` | 状态与统计 |
| `lib/web/api/plugins.js` | 插件列表（读阶段 1 元数据） |
| `lib/web/api/config.js` | 配置读写（阶段 5 的 schema 校验） |
| `lib/web/api/logs.js` | SSE 日志流 |
| `lib/web/security.js` | 令牌桶限流、body 大小上限、411 处理 |
| `dashboard/` | 前端工程（独立 package.json） |
| `docs/openapi.yaml` | API 契约 |

> **落地情况（2026-09-24）：本表的 `api/{router,status,plugins,config}.js` 与 `security.js` 已落地。**
>
> v1 的四个接口（全部是 `GET`，均需鉴权；路径集中在 `api/router.js`，与未来的
> `openapi.yaml` 一一对应）：
>
> | 接口 | 返回 |
> |---|---|
> | `/api/v1/ready` | `{ ready, online, uptime }`。前端的等待页只依赖它 |
> | `/api/v1/status` | 版本、在线状态、运行时长、内存、运行时、插件计数、适配器列表、账号列表 |
> | `/api/v1/plugins` | 已加载插件的**执行顺序**（即 `priority` 排序后的）与规则摘要 |
> | `/api/v1/config` | 文件清单 + 与出厂默认的差异**条数** |
> | `/api/v1/config/{name}` | 该文件在用户侧与默认侧的**值**（密钥键已脱敏） |
> | `/api/v1/logs` | SSE 实时日志流（先回放最近 200 条，之后实时推；每 15 秒一个心跳） |
>
> 三个设计决定：
>
> 1. **插件列表读内存里的 `priority`，不读磁盘上的 `plugin.json`。**
>    面板要回答的是"现在生效的是哪些"；插件被 `disable` 掉之后 `plugin.json` 仍在磁盘上，
>    用磁盘数据会造出"面板里有、实际不工作"的错觉。顺序原样保留，因为那就是执行顺序。
> 2. **配置清单只给差异条数，值只在单文件接口里给**，且密钥键（`password`/`token`/`auth`/
>    `secret`/`credential`/`cookie`）**整个值**被遮住并在 `redacted` 里列出路径。
>    静默打码比不打码更糟——用的人会以为配置就是 `***`。
>    （刻意不遮 `key`：`https.key` 是证书**路径**，遮了反而难排查。）
> 3. **`?file=` 先过白名单**（`^[\w.-]+\.ya?ml$` 且 `basename` 必须等于原名），
>    恢复/读取类接口最典型的漏洞就是让请求决定路径。
>
> 还有一处**实测才发现的坑**：响应头必须带 `Cache-Control: no-transform`。
> 宿主链上有 `compression()`，它会把小于阈值的响应攒在缓冲区里——而 SSE 全是小分片，
> 不声明就等于"连上了但一条都看不到"。测试里特意把 `compression()` 也接进链路，
> 少了这个头就会红。
>
> ### 日志流为什么用 log4js appender，而不是 tail 落盘文件
>
> 落盘文件是现成的（`plugins/other/sendLog.js` 的 `#日志` 就读它），但
> `appenders.command` 只收 `warn` 与 `mark`——**`info` / `debug` 根本不落盘**（只进 stdout）。
> 面板上缺的恰恰是"插件加载了哪些"这类 info，所以改成给 log4js **追加一个 appender**，
> 拿的是与终端同一份日志事件。
>
> 代价与约束：
>
> - 需要 `log4js.configure()` 再跑一次。配置对象从 `lib/config/log.js` 新增的
>   `buildLogConfig()` 来，**不是复制一份**——两份副本的后果是"面板上的日志和终端不是一套"；
> - 只在面板启用时才重配，且**失败不抛**：面板看不到日志可以接受，
>   "日志系统被面板弄坏"不可以（那时旧配置仍然生效）；
> - log4js 6 的自定义 appender 必须写成 `type: { configure: () => event => … }`，
>   **不能直接给函数**——那样它会把 `type` 当模块名去 `require`（实测报 MODULE_NOT_FOUND）；
> - 三个分类都要挂：一次日志调用只会进一个分类，所以不会重复；
> - 断开清理靠 `req`/`res` 的 `close`（两个都会发，清理写成幂等）。
>
> **样例**（真机取，已去掉 ANSI 颜色）：
>
> ```
> [MARK] (command) [   WebUI  ] WebUI 已挂载：/api/v1（鉴权头：Authorization）
> [INFO] (message) [ WebSocket] 连接地址：ws://localhost:2536/[GSUIDCore,OPQBot,…]
> [MARK] (command) [http://127.0.0.1:2536/api/v1/status <= ::ffff:127.0.0.1:3772] HTTP GET 请求 {…
> ```
>
> 分类名是"哪个 logger 发的"（`message` 是 `defaultLogger` 的名字），原样展示不做好看化——
> 它就是排查时用来定位分类的。
>
> **真机验证（2026-09-24，同样临时改配置、验完已还原）**：
>
> ```
> status:  version=3.1.3 online=2 uptime=29s rss=108.41MB node=v24.19.0
>          插件计数 {"handlers":27,"loaded":27,"tasks":0}  适配器 7  账号 [{"uin":"stdin"}]
> plugins: total=27
>          botOperate [system/botOperate.js] priority=null rules=2 (reg=^#(Bot|机器人)验证.+:.+$, fnc=Verify)
> config:  files=9 summary={"files":2,"missing":3,"extra":1,"changed":1}
> server.yaml: status=both redacted=["auth"] auth="***" port=2536
> 路径穿越 ../package.json → 400 {"code":"bad_request",…}
> 不存在的文件            → 404 not_found
> ```
>
> 两点值得说：
>
> - `redacted: ["auth"]` 那一行是重点——当时配置里确实写着临时令牌，而**响应体里没有它**；
> - `config` 的那几个数字包含了**那次临时改动本身**带来的差异（`webui.enable` 被改过），
>   不是这台机器的正常状态。真机上更有价值的信息是清单里 9 个文件都是 `both`，
>   即"两侧都有"的文件也不会从清单里消失（这正是自己列目录、而不是直接用
>   `collectDiff()` 的差异清单的原因）。

改动：

| 文件 | 改动 |
|---|---|
| `lib/bot.js` | 引入 `lib/web/server.js`；**不改** 现有路由与鉴权逻辑 |
| `lib/config/log.js` | 抽出 `buildLogConfig()`（配置对象的**唯一**来源），供日志流追加 appender |
| `config/default_config/server.yaml` | 新增 `server.webui.enable`（默认 `false`）、`server.address`；保持既有键不变 |

---

## 5. 验收标准

- [x] 默认配置下 WebUI **不启用**，行为与改造前完全一致
      —— 有单测：未启用时不挂载、**零日志**，请求落到宿主的兜底
- [x] `auth` 为空时启用 WebUI 会被拒绝，日志给出明确配置指引
      —— 有单测：`mount()` 返回 `reason: "no-auth"`，日志含「server.auth 为空」与 `config/config/server.yaml`
- [x] `/status`、`/exit`、`/File` 与适配器注册的路由行为不变（有回归测试）
      —— 单测证明启用 WebUI 时这三个路径仍由原本的处理器答复（互不遮蔽），
      且其余路径照旧走宿主的兜底跳转；真机又跑了一遍真实的 `serverAuth`（401）
      与 `/exit`（`app stop` 确实让进程退出了）
      ⚠️ **缺口**：没有直接调用 `lib/bot.js` 里那三个处理器的单测——导入它会撞上
      测试环境的 O6（`logger.defaultLogger`），所以那一条只能靠真跑覆盖
- [x] CI 中契约与代码同步（见 §3.2：**偏离原方案**，改为直接断言契约↔路由/响应体一致，
      跑在 `pnpm test` 里，同样是阻塞项）
- [x] 日志 SSE 在客户端断开后服务端正确释放（无句柄泄漏，用连续 100 次连接/断开验证）
      —— 有单测：100 次连接/断开后订阅者始终归零；另一条验证"断开后心跳定时器真的被停掉"
      （等 16 个心跳周期再断言没有新写入，而不是贴着周期断言：Windows 与 CI runner 的
      定时器粒度能到 10ms 以上）。真连接断开也走同一条清理路径
- [x] 启动期（`stat.online !== 2`）访问 `/dashboard` 有明确提示，不出现无限转圈
      —— 503 + `Retry-After` + 自动重试页（有单测）
- [ ] 敏感接口有 per-IP 限流，压测下返回 429 而非击穿
      —— 限流本身已落地且有 429 用例；v1 是只读面板，**敏感接口（重启/更新）还未出现**，
      届时在对应子路径上再叠一层更紧的桶
- [x] 请求体超过上限返回 413，无 `Content-Length` 的 multipart 返回 411
      —— 两条都有真实 HTTP 用例

---

## 6. 风险

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| **WebUI 引入新的攻击面** | 中 | **极高** | 默认关闭 + 强制鉴权 + 仅本机监听 + 限流；敏感操作审计日志 |
| 契约漂移（yaml 与实现不一致） | 高 | 中 | `tests/unit/web/openapi.test.js` 将契约与真实路由/真实响应体双向比对（跑在 `pnpm test` 里）；前端落地后可再叠一层「生成 + diff」 |
| 启动期请求挂起语义导致前端体验差 | 中 | 低 | `/api/v1/ready` 探针 + 前端等待页 |
| SPA 与适配器路由冲突 | 低 | 中 | 所有新路径统一加前缀（`/dashboard`、`/api`）；不注册根路径 |
| 前端工程使仓库体积膨胀 | 中 | 低 | `dashboard/node_modules` 与构建产物均在 `.gitignore` 中；CI 缓存依赖 |
| 与阶段 7 的插件页面耦合过深 | 中 | 中 | 插件页面延到 v3，作为可选能力 |

---

## 7. 前端交接说明（`dashboard/`）

> 本节是**交接单**：接手前端的 agent 按这里走即可，不必先读后端的实现细节。
> **硬性规则与文档纪律在 `AGENTS.md`（必读）与 `dev-notes.md`。**

### 7.1 范围：v1 只读面板

四个页面，数据全部来自已经稳定的 5 个接口（契约见 `docs/openapi.yaml`）：

| 页面 | 数据源 |
|---|---|
| 状态总览 | `GET /api/v1/status`（`/ready` 作启动探针） |
| 插件列表 | `GET /api/v1/plugins` |
| 配置查看 | `GET /api/v1/config` 与 `GET /api/v1/config/{name}` |
| 日志实时流 | `GET /api/v1/logs`（SSE） |

除 7.3 第 5 条（静态资源挂载）外，**不需要后端改动**。

### 7.2 不许越过的边界

| 边界 | 原因 |
|---|---|
| **不改既有路由**：`/status`、`/exit`、`/File` 与适配器注册的路径 | L0 冻结面，见 `99-compat-and-migration.md` §1.1 |
| **构建产物不进仓库**（`dashboard/dist`、`dashboard/node_modules` 已在 `.gitignore`） | 与 AstrBot 不同：Node 侧不需要把 dist 打进分发包 |
| **新路径一律加前缀**，不注册根路径 | 避开与适配器路由冲突 |
| **令牌不进 URL、不进仓库** | 头名与令牌都来自 `server.auth`；进 URL 会写进访问日志与浏览器历史 |
| **要新字段先改契约** | `tests/unit/web/openapi.test.js` 会对真实响应体做双向比对，新字段不写进契约就会红——这是设计意图，不是障碍 |
| **不新增依赖，除非直接解决当前问题** | `AGENTS.md` 规则 5 |

### 7.3 起步步骤

1. `pnpm-workspace.yaml` 的 `packages` 加一项 `dashboard`（当前只有 `plugins/**`）。
2. `dashboard/package.json`：Vue 3 + Vite + Vuetify 3 + Pinia + vue-router；目录结构照 §3.4（与 AstrBot 同构）。
3. 客户端：这 5 个 `GET` 很简，**手写完全可行**；要用 `@hey-api/openapi-ts` 从
   `docs/openapi.yaml` 生成到 `dashboard/src/api/generated/` 再包一层手写外观（§3.2）也行。
   **这是第一个需要走依赖决策的地方。**
4. 联调：后端默认**要求鉴权头**且没有开 CORS。Vite dev server 用 `server.proxy` 转发到
   `http://127.0.0.1:2536`，并在**代理里补上鉴权头**；代理要关掉 `/api/v1/logs` 的响应缓冲。
5. **唯一的后端改动点**：SPA 静态资源要挂到 `/dashboard`。写在 `lib/web/server.js` 的
   `mount()` 里（门卫已经保证"未启用/未配 auth 就不挂"），并把 `/dashboard/assets`
   追加进 `Bot.express.skip_auth`——否则浏览器加载 `<script>` 也得带令牌，而 `<script>`
   没法带头。这个取舍是**刻意的**（静态资源不含密钥，API 仍然要令牌），
   请单独提交并在此表登记。

### 7.4 已知坑（后端踩过并留了用例的）

- **SSE 必须实时**：响应头已带 `Cache-Control: no-transform`（宿主的 `compression()` 会把小于
  阈值的分片攒在缓冲区里，而 SSE 全是小分片）。前端若套反向代理，也要关掉对
  `text/event-stream` 的缓冲。
- **心跳是"连接还活着"的唯一信号**：每 15 秒一个 `: ping` 注释行；连着两个周期没收到就重连。
  连上会先收到最多 200 条回放（`?limit=` 可调）。
- **配置值已经脱敏**：`***` 是后端遮的，`redacted` 给出被遮的路径。界面上要显式说明
  "部分密钥未展示"，否则用的人会以为配置本身就是 `***`。
- **`/config/{name}` 的 `{name}` 走白名单**（`^[\w.-]+\.ya?ml$`）：下拉选项只用后端清单里的
  文件名，不要自己拼路径。
- **插件列表的顺序就是执行顺序**（按 `priority` 升序）：界面上不要再排序，那会丢掉唯一的信息量；
  `priority` 可能是 `null`（插件没声明，实际顺序由数组下标表达）。
- **启动期**：`/dashboard` 会收到 `503`（带 `Retry-After: 2`）而不是"转圈"，前端据此做等待页。
- 工具与环境相关的坑（终端、CI 与本地不一致等）见 `dev-notes.md`。

### 7.5 完成时要做的事

- 按 `AGENTS.md` 规则 8 同步：`PLAN.md` §9、本文件（§5 勾选 + 本节状态），
  必要时 `99-compat-and-migration.md`；
- 新增 `dashboard/README.md`：怎么装、怎么构建、怎么联调、怎么指向后端；
- 若后端因此有改动（7.3 第 5 条），在 §4 的改动表里补一行。
