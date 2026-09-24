# 阶段 6：WebUI 与 API 契约

> 上游：[`05-persistence-config.md`](./05-persistence-config.md) · 下游：[`07-ai-capabilities.md`](./07-ai-capabilities.md)
> 参考实现：AstrBot `dashboard/`、`astrbot/dashboard/api/{router,auth}.py`、`astrbot/dashboard/server.py`、`openspec/openapi-v1.yaml`

## 1. 目标

提供运维界面（状态、插件、配置、日志），并让 HTTP API 有稳定契约，供第三方与插件页面消费。

> **状态（2026-09-24）：进行中 —— 安全基座已落地。**
> 已完成 §3.3 的四条（含两处偏离，见本节末）与启动期就绪语义；
> 只读 API、契约与前端尚未开工。
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
> | `config/default_config/server.yaml` | 新增 `webui.enable`（默认 `false`）与 `address` |
>
> 设置项只增不改：`webui.enable` 不为 `true` 时 `mount()` 不挂载任何路径、**一条日志也不打**，
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
> 测试：`tests/unit/web/{security,server}.test.js` 共 34 个用例，全部走真实 HTTP
> （`node:http` 而不是 `fetch`——后者表达不了「不带 `Content-Length`」的 chunked 请求）。
> 其中一条特意写成断言**性质**而不是次数：限流的回填按真实时间走，
> 「第 61 次必被拦」在快机器上会假红。

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

改动：

| 文件 | 改动 |
|---|---|
| `lib/bot.js` | 引入 `lib/web/server.js`；**不改** 现有路由与鉴权逻辑 |
| `config/default_config/server.yaml` | 新增 `webui.enable`（默认 `false`）、监听地址字段；保持既有键不变 |

---

## 5. 验收标准

- [x] 默认配置下 WebUI **不启用**，行为与改造前完全一致
      —— 有单测：未启用时不挂载、**零日志**，请求落到宿主的兜底
- [x] `auth` 为空时启用 WebUI 会被拒绝，日志给出明确配置指引
      —— 有单测：`mount()` 返回 `reason: "no-auth"`，日志含「server.auth 为空」与 `config/config/server.yaml`
- [x] `/status`、`/exit`、`/File` 与适配器注册的路由行为不变（有回归测试）
      —— 已有的是「早期探针不拦这三个前缀」的用例（它们照旧走宿主链路）；
      **响应内容级别的回归测试**还没写，随只读 API 一起补
- [ ] CI 中 `pnpm generate:api` 后 `git diff --exit-code` 通过（契约与代码同步）
- [ ] 日志 SSE 在客户端断开后服务端正确释放（无句柄泄漏，用连续 100 次连接/断开验证）
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
| 契约漂移（yaml 与实现不一致） | 高 | 中 | CI 强制 `git diff --exit-code` |
| 启动期请求挂起语义导致前端体验差 | 中 | 低 | `/api/v1/ready` 探针 + 前端等待页 |
| SPA 与适配器路由冲突 | 低 | 中 | 所有新路径统一加前缀（`/dashboard`、`/api`）；不注册根路径 |
| 前端工程使仓库体积膨胀 | 中 | 低 | `dashboard/node_modules` 与构建产物均在 `.gitignore` 中；CI 缓存依赖 |
| 与阶段 7 的插件页面耦合过深 | 中 | 中 | 插件页面延到 v3，作为可选能力 |
