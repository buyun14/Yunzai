# AGENTS.md

本仓是 `trss-yunzai` 的**改造仓**，正在按分阶段计划进行架构与工程化重构。

> **动手前必读**：[`docs/refactor/PLAN.md`](docs/refactor/PLAN.md) 是总纲，
> [`docs/refactor/99-compat-and-migration.md`](docs/refactor/99-compat-and-migration.md) 是兼容性契约与破坏性变更登记表。

## 环境

| 项 | 要求 |
|---|---|
| Node | `>= 22.12.0`（由 `file-type@22`、`puppeteer`、`chokidar@5` 决定；开发机固定为 `.nvmrc` 中的 `24.19.0`） |
| 包管理 | `pnpm@12.6.0`（见 `package.json` 的 `packageManager`） |

## 常用命令

```bash
pnpm install

# 质量闸门（提交前必须全绿）
pnpm lint            # prettier --check .（同时充当语法检查）
pnpm lint:eslint     # eslint .
pnpm typecheck       # tsc -p jsconfig.json --noEmit
pnpm test            # vitest run

# 本地修格式
pnpm format

# 运行
pnpm app             # node .
pnpm dev             # node . dev
pnpm web             # 模板调试页（端口 8000，不是运维面板）
```

## 硬性规则

### 1. 不得改动 L0 冻结面

这些路径与符号被内置插件和第三方插件直接依赖，**任何重构都不得移动或删除**。完整清单见
[`99-compat-and-migration.md`](docs/refactor/99-compat-and-migration.md) §1.1，`tests/unit/compat/frozen-surface.test.js` 会在 CI 中兜底。

- 路径不可变：`lib/config/config.js`、`lib/plugins/loader.js`（内置插件用相对路径 import 它们）
- `package.json` 的 `imports` 映射 `#miao` / `#miao.models` 不可删除（`lib/plugins/plugin.js` 会动态 `import("#miao")`）
- 全局变量不可移除：`Bot`、`logger`、`redis`、`plugin`、`segment`、`Renderer`、`start_type`
- 事件对象 `e` 的既有字段（`msg` / `img` / `atBot` / `isPrivate` / `isGroup` / `isMaster` / `logText` / `file` / `reply_id` / `getReply` / `recall` / `hasAlias` / `only_reply_at` 等）语义不可变，只能新增
- 适配器契约不可变：`Bot.adapter` 为数组且 `push` 按 `path` 去重；事件经 `Bot.em("<post_type>.<message_type>.<sub_type>", data)` 逐级退化投递

### 2. 破坏性变更必须先登记

任何破坏性变更（含依赖增删、配置键改名、路径调整）都必须先在
[`99-compat-and-migration.md`](docs/refactor/99-compat-and-migration.md) §4 登记，才可合入。

### 3. 提交信息用 Conventional Commits

`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf` / `build` / `ci`。
由 `.husky/commit-msg` + `commitlint` 强制。

### 4. 注释与日志用中文

与仓库现状保持一致（不要因为参考实现是英文的就把注释改成英文）。

### 5. KISS

- 只解决当前问题，不为"以后可能需要"提前抽象；
- 不新增依赖，除非它直接解决当前问题且有明确证据需要；
- 优先内联实现，重复出现 3 次以上才提取函数。

### 6. 不新增报告类文件

不要创建 `*_SUMMARY.md`、`*_REPORT.md` 之类的临时产物。
改造相关文档一律进 `docs/refactor/`，调研笔记进 `docs/research/`。

### 7. Redis 键必须带类别前缀，不许手拼

用 `lib/config/redis-keys.js` 的 `cacheKey()` / `persistKey()`，**不要**自己写
`` `Yz:xxx` `` 这样的字面量。两类前缀的含义只有一条判据——**清了会不会丢东西**：

| 前缀 | 含义 | 可不可以清 |
|---|---|---|
| `Yz:cache:` | 过期即失效，或能由原始数据重建（冷却、去重、上下文、在线/重启标记） | **可以**，清了不丢东西 |
| `Yz:persist:` | 累计计数与统计 | **不可以**，清了就是丢数据 |

判据说不清属于哪一类时，默认用 `cacheKey()`——**把长期数据误判成可清是唯一会造成
损失的错**。

`tests/unit/config/redis-keys.test.js` 里有一条扫描守卫：`lib/` 与内置插件目录下
出现形如 `` `Yz:...` `` 的键字面量就会红（`plugins/miao-plugin` 除外，它是第三方，
有自己的 `miao:` 命名空间）。

⚠️ 改前缀时**读写两端必须同时改**。这类改造最典型的失败是只改一半，而后果是静默的：
`plugins/system/status.js` 读不到计数时返回 0，不会报错。

### 8. 文档即状态

状态只写在文档里。一个阶段（或一次有分量的改动）结束后必须同步三处：
`PLAN.md` §9 进度总表、对应分册（`> 落地情况` 块 + 验收勾选）、
`99-compat-and-migration.md`（L1 适配 / BCR 登记）。

**勾选验收项要附证据**（文件路径 / 命令 / 实测输出）。没有证据的勾选等于把“没人核实过”
伪装成“已验证过”。反过来，**发现文档与代码不一致时先修文档**——一份过时的进度表
会让下一个人（或下一次会话）基于错误前提做决策。

细节与检查单见 [`dev-notes.md`](docs/refactor/dev-notes.md) §8。

## 遇到问题先查哪里

本仓的知识分散在几处，按问题类型定位，不要重新推一遍：

| 问题 | 去哪找 |
|---|---|
| 现在做到哪了 / 下一阶段是什么 | [`PLAN.md`](docs/refactor/PLAN.md) §9 进度总表 |
| 某个设计为什么这么取舍 | 对应分册正文 + `PLAN.md` §8 的 ADR 表 |
| 能不能改这个符号 / 路径 | `99-compat-and-migration.md` §1.1 的 L0 冻结清单 |
| 我这次改动破坏了什么 | `99-compat-and-migration.md` §1.2 的 L1 登记表 + §4 的 BCR 表 |
| 已知缺陷、“这不是缺陷”的误判 | [`baseline/static-analysis.md`](docs/refactor/baseline/static-analysis.md)（D1-D9）、[`baseline/startup.md`](docs/refactor/baseline/startup.md)（O1-O7） |
| 工具链 / 终端的坑、本地绿而 CI 红 | [`dev-notes.md`](docs/refactor/dev-notes.md) |
| 测试怎么写、覆盖率怎么算 | [`03-engineering.md`](docs/refactor/03-engineering.md) §3.4 |
| 参考实现（AstrBot）借鉴了哪个文件 | 各分册顶部的「参考实现：」行；需长期保留的调研结论进 `docs/research/` |
| 上游改了什么、怎么同步回来 | `99-compat-and-migration.md` §5 |
| 面向人的上手流程 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## 目录约定

```
lib/                    内核
  config/               配置加载（config.js 路径冻结）
  plugins/              插件加载与调度（loader.js 路径冻结）
  pipeline/             [阶段 2 ✅] 消息流水线（Stage 链 + 调度器 + dispatch.js）
  message/              [阶段 4 ✅] 统一消息组件、umo 会话键、组件渲染
  adapter/              [阶段 4 ✅] 适配器注册表与能力表
  web/                  [阶段 6 进行中] WebUI 的挂载门卫、安全中间件与 /api/v1
  events/ listener/     事件入口 → EventBus（lib/event-bus.js）
plugins/                内置与第三方插件
tests/                  vitest
  unit/ helpers/ fixtures/
docs/refactor/          改造规划与实践文档（PLAN.md 是导航）
  baseline/             阶段 0 的静态分析与启动基线（D1-D9 / O1-O7 在此）
docs/research/          参考实现调研笔记（尚未创建，按需）
dashboard/              [阶段 6] WebUI（尚未创建）
lib/compat/             [持续] 兼容适配层（尚未创建——目前没有需要适配的旧 API）
```

## 上游同步

开发仓与 `git@github.com:TimeRainStarSky/Yunzai.git` 是同源分叉关系。

```powershell
git fetch upstream main
git diff --stat upstream/main HEAD        # 相对基线的全部改动
git log --oneline HEAD..upstream/main     # 上游新增但本地没有的提交
```

`upstream` 的 push 地址已设为 `DISABLE`，不要向它推送。
同步流程与检查单见 [`99-compat-and-migration.md`](docs/refactor/99-compat-and-migration.md) §5。
