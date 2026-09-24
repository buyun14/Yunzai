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

### 1.2 L1 适配层

| 原则 | 说明 |
|---|---|
| 方向单向 | 只允许「新契约 → 旧契约」的适配，禁止反向 |
| 不含业务逻辑 | 适配层只做结构转换与默认值填充 |
| 位置集中 | 全部放在 `lib/compat/`，便于统计与最终删除 |
| 必须登记淘汰条件 | 每条适配在本文件第 4 节登记；无淘汰条件的适配不允许合入 |
| 必须可观测 | 命中适配时输出一次性 debug 日志（同一插件只提示一次），便于统计存量 |

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
| 2 | 事件处理时序、`deal()`、`lib/events/*.js` | 行为静默变化（见 `02-pipeline.md` §2.2 三处顺序约束） | 影子运行逐决策点对比；保留 `deal()` 兼容入口 |
| 3 | 无 | 若为可测性重构生产代码会引入无谓 diff | `vi.stubGlobal` 隔离；生产代码只在既定改造中变动 |
| 4 | `e.*` 全部字段、`e.reply` 签名、适配器契约 | 影响面最大 | 分 v1/v2/v3 三步，每步零行为变化，录制样本逐字段对比 |
| 5 | `config/config/*.yaml` 结构 | 损坏用户配置 | 迁移前强制备份；失败即中止；只增改已知键 |
| 6 | `lib/bot.js` 的中间件与路由 | 新路径与既有路由冲突、鉴权被绕过 | 新路径统一前缀；`/status`、`/exit`、`/File` 加回归测试 |
| 7 | 无（未启用时不生效） | 密钥与依赖泄漏 | 独立密钥路径；optional 依赖；不改变 1-6 的行为 |

---

## 3. 重点插件登记表

改造前需逐项验证；验证方式统一为「启动 → 触发该插件的核心命令 → 行为与基线一致」。

| 插件 | 类型 | 用到的 L0 面 | 验证状态 | 备注 |
|---|---|---|---|---|
| `plugins/miao-plugin` | 第三方（生态核心） | `#miao` / `#miao.models` imports、`Common`、`Renderer` | ⬜ 待验证 | 已 clone 到 `plugins/`。**最高优先级**——它是 `lib/plugins/plugin.js` 的硬依赖来源 |
| `plugins/adapter/OneBotv11.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf`、`Bot.express` | ⬜ 待验证 | 最完整、最常用，作为适配器契约的基准 |
| `plugins/adapter/Milky.js` | 内置适配器 | 同上 + `Bot.express.post` | ⬜ 待验证 | 挂 HTTP 路由的样本 |
| `plugins/adapter/Satori.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.emit("online"/"offline")` | ⬜ 待验证 | 直接 `emit` 而非 `em`，需确认兼容 |
| `plugins/adapter/ComWeChat.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf` | ⬜ 待验证 | — |
| `plugins/adapter/GSUIDCore.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf` | ⬜ 待验证 | — |
| `plugins/adapter/OPQBot.js` | 内置适配器 | `Bot.adapter`、`Bot.em`、`Bot.wsf` | ⬜ 待验证 | — |
| `plugins/adapter/stdin.js` | 内置适配器 | `Bot.adapter`、`Bot.em` | ⬜ 待验证 | 最小适配器，适合做契约单测的样例 |
| `plugins/system/status.js` | 内置 | 相对 import `loader.js`、`redis`、`cfg` | ⬜ 待验证 | 直接 import `lib/plugins/loader.js`，阶段 2 改动面最大 |
| `plugins/system/{add,friend,invite,quit,master,botOperate,disablePrivate,recallReply}.js` | 内置 | `cfg` 相对 import、`e.*`、`redis` | ⬜ 待验证 | — |
| `plugins/other/{install,update,restart,version,sendLog}.js` | 内置 | `git` 调用、`cfg`、`redis` | ⬜ 待验证 | `update.js` 会 `git pull`，注意不要误操作本仓 |
| `plugins/example/*.js` | 示例 | 基础 API | ⬜ 待验证 | 被 `.gitignore` 排除但上游强制跟踪，纳管方式见 `00-prep.md` |

---

## 4. 破坏性变更登记表

任何破坏性变更必须在此登记后才可合入。

| 编号 | 阶段 | 变更 | 影响面 | 兼容层 | 迁移方式 | 淘汰条件 | 状态 |
|---|---|---|---|---|---|---|---|
| BCR-0001 | 5 | 删除 `sequelize` / `sqlite3` 依赖与 `db.yaml` | 声明了这些依赖的未知第三方插件 | 无（当前仓库内零引用） | 删除前 grep 确认；`db.yaml` 移入备份目录而非直接删除；CHANGELOG 说明 | 发布两个版本后 | 📝 待决策 |

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
#   upstream  git@github.com:TimeRainStarSky/Yunzai.git (fetch)
#   upstream  DISABLE (push)        ← 防止误推
```

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
