# 兼容层与迁移登记

> 贯穿全部阶段。任何阶段引入破坏性变更，都必须先在本文件登记。

## 1. 三层兼容策略

### 1.1 L0 冻结层（永不破坏）

以下内容从代码推导得出，**任何阶段都不得改动其语义或路径**。

#### 全局对象

| 全局 | 来源 | 备注 |
|---|---|---|
| `Bot` | `app.js`：`global.Bot = new (await import("./lib/bot.js")).default()` | 是个 Proxy，未知属性会回落到 `util` 与 `bots[uin]` |
| `logger` | `lib/config/log.js:90`（`global.logger = chalk`） | 插件中大量裸用 |
| `redis` | `lib/config/redis.js:10` | — |
| `plugin` | `lib/plugins/loader.js:14` | 插件基类 |
| `segment` | `lib/plugins/loader.js:15`（来自 `oicq`） | 节点构造器 |
| `Renderer` | `lib/renderer/loader.js:8` | 渲染器 |
| `start_type` | `app.js` 的 `switch` 分支 | `internal` / `external` / `pm2` |

#### 插件基类契约

- 构造参数：`name` / `dsc` / `handler` / `namespace` / `event` / `priority` / `task` / `rule`
- 实例成员：`reply()`、`conKey()`、`e`、`accept()`、`getContext()`、`name`、`dsc`、`priority`、`rule`、`handler`、`task`、`namespace`
- `rule` 字段：`reg` / `fnc` / `event` / `log` / `permission`（取值 `master` / `owner` / `admin` / `all`）
- `task` 字段：`name` / `cron` / `fnc` / `log`

#### 事件对象 `e` 的字段

由 `lib/bot.js` 的 `prepareEvent()` 与 `lib/plugins/loader.js` 的 `dealEvent()` 共同产出：

```
标识：self_id, user_id, group_id, message_id, raw_message, post_type, message_type, sub_type
对象：message, sender, group, friend, member, bot
归一化：msg, img, at, atBot, file, reply_id, getReply, recall
判定：isPrivate, isGroup, isMaster, hasAlias, only_reply_at
日志：logText, logFnc
适配器：adapter_id, adapter_name
方法：reply()
派生：isSr / isGs（loader.js 中定义的 getter）
```

#### 不可移动的文件路径

内置插件用**相对路径** import 内核文件，移动这些文件会导致插件全部失败：

| 文件 | 被引用处 |
|---|---|
| `lib/config/config.js` | `plugins/system/{add,disablePrivate,friend,invite,quit,status}.js` 的第 1 行 |
| `lib/plugins/loader.js` | `plugins/system/status.js:2` |

> 约束：这两个文件的**路径**不可变。内部实现可以重构，对外导出必须保持。

#### `package.json` 的 `imports` 子路径

```jsonc
"imports": {
  "#miao": "./plugins/miao-plugin/components/index.js",
  "#miao.models": "./plugins/miao-plugin/models/index.js"
}
```

`lib/plugins/plugin.js` 顶部会：

```js
let Common
try {
  Common = (await import("#miao")).Common
} catch {}
```

因此该映射与 `miao-plugin` 的目录结构都属于冻结范围。**改造不得重命名 `plugins/miao-plugin`，也不得删除这两个 import 映射。**

#### 适配器契约

| 约定 | 依据 |
|---|---|
| `Bot.adapter` 为数组，`push` 按 `path` 去重 | `lib/bot.js:44-52` |
| 项需含 `id` / `name` / `path` / `makeLog` / `sendApi`（或等价发送方法） | `plugins/adapter/OneBotv11.js:6-33` |
| 事件投递：`Bot.em(\`${post_type}.${message_type}.${sub_type}\`, data)` | 7 个适配器共 20+ 处 |
| `Bot.wsf[path]` 注册 WebSocket 处理器 | `OneBotv11.js:1547` 等 4 处 |
| `Bot.express.<method>(path, handler)` 挂 HTTP 路由 | `plugins/adapter/Milky.js:100` |

#### HTTP 层语义

- `cfg.server.auth`：`{ 请求头名或查询参数名: 令牌 }`，任一不匹配即 401；为空则完全放行
- `Bot.express.skip_auth`：前缀数组，命中的路径跳过鉴权
- `Bot.express.quiet`：前缀数组，命中的路径降为 debug 日志
- 既有路由：`/status`、`/exit`、`/File`

> **阶段 6 的追加（2026-09-24，只增不改）**：`skip_auth` 里多了一个
> `/dashboard/assets`，仅当 `server.webui.enable === true` 且 `server.auth` 非空时写入
> （`lib/web/server.js` 的 `frontend()`）。**只追加、不移除、不改判断方式**，
> 既有前缀与既有路由的行为逐字不变。
>
> 同一阶段还多了一层**前端中间件**，插在 `serverAuth` **之前**
> （`lib/bot.js` 的 `express` 链：`earlyProbe` → 前端 → `serverAuth`）。
> 它只对 `GET/HEAD` 的 `/dashboard` 与 `/dashboard/` 直接答复入口文档，
> 其余一律 `next()`；未启用 WebUI 时是纯透传。理由与边界见 BCR-0002。
>
> **同期的删除（2026-09-24，BCR-0003）**：`server.redirect` 这个配置键与
> 「未命中路径 302 到框架作者仓库」的兜底行为已删除，兜底改为 404 JSON。
> 这一条是**减少**对外行为，不是新增契约；旧配置里残留的键会被静默忽略。

### 1.2 L1 适配层

| 原则 | 说明 |
|---|---|
| 方向单向 | 只允许「新契约 → 旧契约」的适配，禁止反向 |
| 不含业务逻辑 | 适配层只做结构转换与默认值填充 |
| 位置集中 | 全部放在 `lib/compat/`，便于统计与最终删除 |
| 必须登记淘汰条件 | 每条适配在本文件第 4 节登记；无淘汰条件的适配不允许合入 |
| 必须可观测 | 命中适配时输出一次性 debug 日志（同一插件只提示一次），便于统计存量 |

已登记的 L1 适配：

| 编号 | 阶段 | 适配内容 | 淘汰条件 |
|---|---|---|---|
| ~~L1-0001~~ | 2 | ~~`bot.legacy_pipeline: true` → 走旧 `PluginsLoader.deal()` 而非新流水线~~ | **已淘汰（2026-09-24，阶段 2 第 5 步）**：开关与 `deal()` 一并删除。**偏离了原淘汰条件**（原定"跑完两个发布版本"）——实际在阶段 4 真机浸泡通过后即清理。用户配置里残留的 `bot.legacy_pipeline` 现在是无效的多余键 |

### 1.3 L2 新契约

| 阶段 | 新契约 |
|---|---|
| 1 | `plugin.json`、`config.schema.json`、声明式过滤（`scope` / `platforms` / `when` / `onDenied`） |
| 2 | `Stage` / `StageOrder` / `PipelineContext` / `EventBus` |
| 3 | 测试、类型、CI 闸门（对插件作者是 `plugin.json` 的 `yunzai` 字段） |
| 4 | `Component` 消息模型（`e.components`）、`umo`、适配器 `capabilities` |
| 5 | 配置版本化与迁移（对插件作者是 `config.schema.json` 的 `default`） |
| 6 | `/api/v1` 契约（`docs/openapi.yaml`） |

---

## 2. 阶段 × 兼容影响矩阵

| 阶段 | 触及的 L0 面 | 主要风险 | 缓解手段 |
|---|---|---|---|
| 0 | 无 | 无 | 只加工具链与文档 |
| 1 | 插件基类构造参数（**新增可选参数**） | 构造函数签名变化导致旧插件异常 | 只新增可选参数，不改变现有解构默认值 |
| 2 | 事件处理时序、`deal()`、`lib/events/*.js` | 行为静默变化（见 `02-pipeline.md` §2.2 三处位置约束） | 影子运行逐决策点对比；`deal()` **一行未改**作为回退路径；`bot.legacy_pipeline` 开关可热切换。**第 5 步后两者均已删除**，行为由 `tests/fixtures/pipeline/baseline-snapshots.json`（录自经两侧互证的旧侧结果）守卫 |
| 3 | 无 | 若为可测性重构生产代码会引入无谓 diff | `vi.stubGlobal` 隔离；生产代码只在既定改造中变动 |
| 4 | `e.*` 全部字段、`e.reply` 签名、适配器契约 | 影响面最大 | 分 v1/v2/v3 三步，每步零行为变化，录制样本逐字段对比 |
| 5 | `config/config/*.yaml` 结构 | 损坏用户配置 | 迁移前强制备份；失败即中止；只增改已知键 |
| 6 | `lib/bot.js` 的中间件与路由；`config/default_config/server.yaml` 少一个 `redirect` 键 | 新路径与既有路由冲突、鉴权被绕过；未命中路径的响应形状变化 | 新路径统一前缀；`/status`、`/exit`、`/File` 加回归测试；兜底的 302→404 变化按 BCR-0003 登记 |
| 7 | 无（未启用时不生效） | 密钥与依赖泄漏 | 独立密钥路径；optional 依赖；不改变 1-6 的行为 |

---

## 3. 重点插件登记表

改造前需逐项验证；验证方式统一为「启动 → 触发该插件的核心命令 → 行为与基线一致」。

| 插件 | 类型 | 用到的 L0 面 | 验证状态 | 备注 |
|---|---|---|---|---|
| `plugins/miao-plugin` | 第三方（生态核心） | `#miao` / `#miao.models` imports、`Common`、`Renderer` | ✅ 已真机验证 | 已 clone 到 `plugins/`。**最高优先级**——它是 `lib/plugins/plugin.js` 的硬依赖来源。阶段 2 中它是揪出缺陷的关键：它的 `getContext` 与处理器都依赖 `this.e`，单测夹具没盖住 |
| `plugins/adapter/OneBotv11.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf`、`Bot.express` | ⬜ 待验证 | 最完整、最常用，作为适配器契约的基准 |
| `plugins/adapter/Milky.js` | 内置适配器 | 同上 + `Bot.express.post` | ⬜ 待验证 | 挂 HTTP 路由的样本 |
| `plugins/adapter/Satori.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.emit("online"/"offline")` | ⬜ 待验证 | 直接 `emit` 而非 `em`，需确认兼容 |
| `plugins/adapter/ComWeChat.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf` | ⬜ 待验证 | — |
| `plugins/adapter/GSUIDCore.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf` | ⬜ 待验证 | — |
| `plugins/adapter/OPQBot.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf` | ⬜ 待验证 | — |
| `plugins/adapter/stdin.js` | 内置适配器 | `Bot.adapter`、`Bot.em` | ✅ 已真机验证 | 最小适配器。阶段 2 的真机端到端验证全靠它：可以直接喂消息而不需真实账号 |
| `plugins/system/status.js` | 内置 | 相对 import `loader.js`、`redis`、`cfg` | ✅ 已真机验证 | 直接 import `lib/plugins/loader.js`，阶段 2 改动面最大 |
| `plugins/system/{add,friend,invite,quit,master,botOperate,disablePrivate,recallReply}.js` | 内置 | `cfg` 相对 import、`e.*`、`redis` | ⬜ 待验证 | — |
| `plugins/other/{install,update,restart,version,sendLog}.js` | 内置 | `git` 调用、`cfg`、`redis` | ⬜ 待验证 | `update.js` 会 `git pull`，注意不要误操作本仓 |
| `plugins/example/*.js` | 示例 | 基础 API | ⬜ 待验证 | 被 `.gitignore` 排除但上游强制跟踪，纳管方式见 `00-prep.md` |

---

## 4. 破坏性变更登记表

任何破坏性变更必须在此登记后才可合入。

| 编号 | 阶段 | 变更 | 影响面 | 兼容层 | 迁移方式 | 淘汰条件 | 状态 |
|---|---|---|---|---|---|---|---|
| BCR-0001 | 5 | 删除 `sequelize` / `sqlite3` 依赖与 `db.yaml` | 声明了这些依赖的未知第三方插件 | 无（当前仓库内零引用） | 删除前 grep 确认；`db.yaml` 移入备份目录而非直接删除；CHANGELOG 说明 | 发布两个版本后 | � 告警期（2026-09-24 已决策删除，未执行） |
| BCR-0002 | 6 | 面板的两个前端路径免鉴权：`/dashboard/assets` 进 `skip_auth`，`/dashboard` 与 `/dashboard/` 由前端中间件直接答 | **既有路径零影响**（只追加前缀，`serverAuth` 的判断逻辑与顺序都没动）。新增两处**免鉴权**入口 | 无 | 只在 `server.webui.enable === true` **且** `server.auth` 非空时生效；默认关闭时 `mount()` 连日志都不打，`skip_auth` 保持空数组 | 面板改为把令牌烘进 HTML（不打算做） | 已合入（2026-09-24） |
| BCR-0003 | 6 | 删除 `server.redirect` 配置键与"未命中路径 302 跳转"行为；兜底改为 **404 JSON** | ① 显式配置过 `redirect` 的部署：该键变成无效的多余键（**不会报错**，与 L1-0001 的 `legacy_pipeline` 同样处理）；② 访问未命中路径的人：从"被跳到框架作者仓库"变成拿到 404 | 无（非必要行为，不提供兼容开关） | 想给自己的站点做落地页就显式注册 `Bot.express.get("/", …)`；旧配置里的 `redirect` 键可删可留 | 无（不打算恢复） | 已合入（2026-09-24） |
| BCR-0004 | 6 | `/api/v1` 从**只读**变成**可写**：新增 `PUT /api/v1/config/{name}` | 面板的权限面扩大了一个量级——通过鉴权的会话可以改写 `config/config/*.yaml`（仅限已建模文件，且不含敏感键） | 无（新能力，不涉及既有行为兼容） | 默认关闭不受影响：`server.webui.enable` 为 false 时整个 `/api/v1` 不挂载。要彻底关掉写能力就关掉面板 | 无（面板的既有能力） | 已合入（2026-09-24） |
| BCR-0005 | 6 | `/api/v1` 新增**进程控制**：`POST /control/restart`、`POST /control/stop` | 面板新增"能把服务停掉"的能力。停止**不会自动恢复**，而且面板本身一起停（它跑在同一个进程里） | 一层来源闸门 `createLocalOnlyGate()`：**只允许本机与内网**，公网一律 403；界面对停止加二次确认 | 不提供开关（要么用面板、要么别开）。默认关闭不受影响 | 无（面板的既有能力） | 已合入（2026-09-24） |

> **BCR-0003 的动机**：`config/default_config/server.yaml` 里的> `redirect: https://git.trss.me/Yunzai` 让**任何未命中的路径**都 302 到框架作者的仓库。
> 对一个自建部署来说这是纯粹的对外噪声：它泄露了一个与本部署无关的第三方地址，
> 也让"这个端口到底是什么服务"变得含糊。属于非必要的个性化行为，删除。
>
> 同一批还清掉了另外三处同类痕迹（都不改契约，只是输出内容）：
>
> | 位置 | 原内容 | 现内容 |
> |---|---|---|
> | `lib/config/init.js` 的 `process.title` | `TRSS Yunzai v… © 2023 - 2026 TimeRainStarSky` | `Yunzai v…` |
> | `lib/config/init.js` 的启动横幅 | 多打一行 `https://git.trss.me/Yunzai` | 去掉，只留程序名与版本 |
> | `lib/config/init.js` + `lib/events/online.js` | `----^_^----` 颜文字标记 | 去掉（上线那处换成一句有信息量的话） |
>
> **真机验证（2026-09-24，默认配置：无 auth、未启用面板）**：
>
> ```
> GET /            → 404 application/json  {"code":"not_found","message":"没有这个路径：GET /"}   无 Location
> GET /whatever    → 404 application/json  （同上形状）                                          无 Location
> GET /git.trss.me → 404 application/json  （同上形状）                                          无 Location
> GET /status      → 200 application/json  （既有路由未受影响）
> 启动横幅：Yunzai v3.1.3 启动中...   ← 不再有作者仓库地址、不再有 ^_^
> ```
>
> **旧配置里的 `redirect` 键怎么处理**：它已经没有任何消费方，留着也**不会报错**
> （与 L1-0001 淘汰后的 `bot.legacy_pipeline` 同样处理），但会让配置文件里多一条
> 误导性内容。本仓自带的 `node . config:diff` 会把它报成
> `多余（你有、默认没有）: redirect`，照着删掉即可（本次也顺手清掉了开发机上的那一份）。
> 刻意**不做**自动迁移：为一个纯装饰性键写迁移脚本，成本大于收益（`AGENTS.md` 规则 5）。

> **BCR-0004 为什么必须登记**：这是面板第一次获得**改宿主状态**的能力。
> 在此之前 `/api/v1` 全是 `GET`，"最坏情况"是泄露信息；现在通过鉴权的会话
> 可以改写配置文件。四道闸门把它收在一个很窄的口子里：
>
> | # | 闸门 | 不过时 |
> |---|---|---|
> | 1 | 文件名白名单（`^[\w.-]+\.ya?ml$` 且 `basename` 等于原名） | 400 |
> | 2 | 该文件在 `HOST_SCHEMAS` 里（**未建模的不给写**：`group.yaml`、`db.yaml`） | 400 |
> | 3 | 请求体不含 `server.yaml` 的 `auth` / `https` | 400 |
> | 4 | 新值过该文件的 schema 校验（**不填默认值**——那等于替用户隐式改写没碰过的键） | 400 |
>
> 另外两处防护：请求体必须带 `confirmed: true`（否则 **428**，不动用 400 是为了让
> 客户端能区分"参数错了"与"还没确认"）；写盘是**原子**的（同目录临时文件 + rename），
> 且写前必先备份到 `config/backups/pre-write-<时间戳>-<原名>`。
>
> **为什么封死 `auth` / `https`**：这两个键决定面板**自己**的门卫与监听。
> 能改 `auth` 就意味着"一个已经通过认证的会话可以换掉令牌、或把所有人锁在外面"；
> 能改 `https` 就意味着"写错证书路径、重启即起不来"。
> 这与 §1.1 里「启用 WebUI 必须配 auth」是同一条思路：**面板不该有能力削弱自己的门卫**。
> 代价明确——面板不能作为认证配置的管理入口，要改就手动改 yaml。
>
> **已知缺口（刻意不做）**：写入路径**没有**单独叠加更紧的限流桶，
> 用的是 `/api/v1` 上那个 per-IP 令牌桶。`06-webui.md` §5 里那条
> 「敏感接口有 per-IP 限流，压测下返回 429」的验收项仍未勾选——
> 等重启/更新这类**更高频且更危险**的接口落地时一起做，那时才有真正的压测对象。
>
> **写入不会立即生效**：配置是启动期一次性读进内存的，所以响应恒带
> `restartRequired: true`。刻意不做热重载——绝大多数键（端口、监听地址、
> 数据库路径）本来就热改不了，为每个键定义"能不能热改"的收益远小于成本。

> **BCR-0002 为什么要走登记**：它确实放宽了鉴权——`<script>` / `<link>` 没法带自定义头，
> 不放行 `/dashboard/assets` 就是「HTML 出来了、脚本全 401」；而**入口文档本身**
> （浏览器打开面板的第一个请求）同样带不了头，只放行 assets 会得到
> 「文档 401、资源 200」的诡异组合（真机实测）。
>
> 判定为**可接受**的依据：① 入口文档与打包产物里不含任何密钥（密钥只出现在
> `/api/v1/*` 的响应里，那些路径仍然要令牌）；② 门卫保证「启用必须有 auth」，
> 所以不存在"放行了文档就等于敞开"的部署；③ `dashboard` 的脚本源码本来就是公开的，
> 多要一个令牌挡不住任何人。
>
> **放宽的边界是刻意收窄的**：`skip_auth` 只拿到 `/dashboard/assets` **一个前缀**
> （它是 `originalUrl.startsWith` 匹配，把 `/dashboard` 整个放进去会连适配器挂在
> 它下面的路由一起免鉴权）；入口文档走的是前端中间件里"只认 `""` 与 `"/"` 两个形状"
> 的判断，`/dashboard/whatever` 照旧 401（有单测守着）。

模板：

```markdown
| BCR-XXXX | <阶段> | <一句话描述变更> | <谁会受影响、影响方式> | <有则写明适配位置；无则说明为何无法兼容> | <自动脚本 / 文档指引> | <何时可以删除兼容层> | <待决策 / 已登记 / 已合入 / 已淘汰> |
```

---

## 5. 上游同步流程

开发仓与上游是"同源分叉"关系，需要定期同步以避免漂移失控。

### 5.1 远端配置

```powershell
# 参考仓（完整上游历史，只读）
E:\ProjectCollection\2026_9\Own\Yunzai

# 开发仓
E:\ProjectCollection\2026_9\Work\Yunzai
git remote -v
#   origin    git@github.com:buyun14/Yunzai.git (fetch/push)   ← 本仓的远端
#   upstream  git@github.com:TimeRainStarSky/Yunzai.git (fetch)
#   upstream  DISABLE (push)        ← 防止误推
```

**`origin` 取代了原来的 `main`（2026-09-24）**：这个仓库里原本躺着一条**与上游
无共同祖先**的独立历史（`36849f0`，提交信息是"修复事件调用与异常清理边界"一类的
自研修复），不是上游的镜像。推本仓 `main` 之前先把它完整保留了下来：

| 分支 | 内容 |
|---|---|
| `origin/main` | **本仓**重构后的历史（`038e354` 起），已设为本地 `main` 的上游 |
| `origin/pre-refactor-main` | 原 `main` 的完整历史（`36849f0`），**只作存档**，不再合并 |

覆盖时用的是 `--force-with-lease` 而不是 `--force`：万一远端在抓取之后又被改过，
它会拒绝推送而不是静默覆盖。本地也留了同名分支 `pre-refactor-main` 便于随时对照。

> 若要取回那条历史：`git fetch origin pre-refactor-main`，或本地直接
> `git log pre-refactor-main`。**不要**把它 merge 进 `main`——两条线没有共同祖先，
> 合并只会得到一个无法维护的怪物；需要某处修复就按 5.3 的策略单独 cherry-pick。

### 5.2 例行检查

```powershell
git fetch upstream main
git diff --stat upstream/main HEAD          # 本地相对基线的全部改动
git log --oneline HEAD..upstream/main       # 上游新增但本地没有的提交
```

### 5.3 重同步策略

| 情况 | 处理 |
|---|---|
| 上游改动落在**未触及**的文件 | 直接 cherry-pick |
| 上游改动落在 `lib/plugins/loader.js` / `lib/bot.js`（本地改造最重的两个文件） | 逐提交人工评审，把上游的修复重写为对应的 Stage 或适配层改动，**不要**直接 merge |
| 上游发新版本 | 先在本仓完成当前阶段的验收，再同步；不同步引入新功能 |
| 上游同样在做架构演进 | 停下本地改造，先评估是否应改为跟随上游设计（避免南辕北辙） |

### 5.4 基线漂移检查单

每次同步后逐项确认：

- [ ] `git diff --stat upstream/main HEAD` 的文件清单与预期的改造范围一致（无意外文件被改动）
- [ ] `plugins/` 与 `lib/` 之外的文件（`package.json` 除外）无改动
- [ ] `package.json` 的 `imports` 映射仍为 `#miao` / `#miao.models` 两条且指向正确
- [ ] `lib/config/config.js` 与 `lib/plugins/loader.js` 的**路径**未变
- [ ] `CHANGELOG.md` 已记录上游同步的版本区间
- [ ] 阶段 0 录制的回归样本仍全部通过

---

## 6. 回归基线的产出物（阶段 0 依赖）

为支撑"零行为变化"的判定，阶段 0 必须产出：

| 产出物 | 位置 | 用途 |
|---|---|---|
| 脱敏事件样本 | `tests/fixtures/events/*.json` | 阶段 2 的影子运行、阶段 4 的逐字段对比 |
| 插件加载清单与耗时 | `docs/refactor/baseline/plugin-load.json` | 阶段 1/2 的性能回归判定 |
| 每个重点插件的核心命令与预期回复 | `docs/refactor/baseline/plugin-behavior.md` | 阶段 1-4 的行为回归判定 |
| 配置快照 | `tests/fixtures/config/<version>/` | 阶段 5 的迁移测试 |

> 这些产出物是"零行为变化"这个承诺的唯一凭据。缺少它们，本文件的所有兼容性声明都只是声明。
