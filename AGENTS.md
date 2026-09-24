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

## 目录约定

```
lib/                    内核
  config/               配置加载（config.js 路径冻结）
  plugins/              插件加载与调度（loader.js 路径冻结）
  pipeline/             [阶段 2] 消息流水线
  message/              [阶段 4] 统一消息组件
  compat/               [持续] 兼容适配层
plugins/                内置与第三方插件
dashboard/              [阶段 6] WebUI（独立 package.json）
tests/                  vitest
  unit/ integration/ fixtures/
docs/refactor/          改造规划与实践文档
docs/research/          参考实现调研笔记
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
