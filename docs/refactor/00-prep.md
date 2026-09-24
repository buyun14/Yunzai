# 阶段 0：前期准备

> 上游文档：[`PLAN.md`](./PLAN.md) · 下游： [`01-plugin-contract.md`](./01-plugin-contract.md)
> 目标：让改造工作有一个可回滚、可校验、有闸门的起点。

---

## 1. 已完成

### 1.1 仓库基线

| # | 事项 | 结果 |
|---|---|---|
| 1 | 创建开发仓目录 | `E:\ProjectCollection\2026_9\Work\Yunzai` |
| 2 | 复制源码（排除 `.git`） | 7808 个文件 / 1381 个目录 |
| 3 | 重新 `git init` | 默认分支 `main` |
| 4 | 补齐被 `.gitignore` 排除但上游强制跟踪的文件 | `config/pm2.yaml`、`data/.gitignore`、`temp/.gitignore`、`plugins/example/*.js` ×2、`resources/http/File/*.jpg` ×2 |
| 5 | 基线提交 | `08818db chore: baseline import of trss-yunzai 3.1.3`（90 个文件，与上游一致） |
| 6 | 注册 `upstream` 只读远端 | fetch 地址为上游仓库，push 地址设为 `DISABLE` 防止误推 |
| 7 | 基线校验 | `git diff upstream/main HEAD` 输出为空 → **内容与上游完全一致** |

```powershell
# 校验命令（随时可重复执行）
git -C "E:\ProjectCollection\2026_9\Work\Yunzai" diff --stat upstream/main HEAD
```

### 1.2 工具链

| 文件 | 作用 |
|---|---|
| `package.json` | `engines.node` / `packageManager` / 精确版本 `devDependencies`；`lint` 改为只读校验 |
| `.nvmrc` | 固定开发 Node 版本 `24.19.0` |
| `.prettierignore` | 排除第三方与生成内容，使 `prettier --check .` 可用 |
| `eslint.config.js` | ESLint flat config，含 L0 全局变量声明 |
| `jsconfig.json` | `checkJs` 的类型检查范围 |
| `vitest.config.js` | 测试入口 |
| `commitlint.config.js` + `.husky/{pre-commit,commit-msg}` | 提交信息与暂存区格式闸门 |
| `lint-staged.config.js` | `lint-staged` 规则 |
| `.github/workflows/ci.yml` | CI 矩阵（2 OS × 2 Node） |
| `AGENTS.md` | 改造仓的强制规则 |
| `tests/unit/compat/frozen-surface.test.js` | **L0 冻结面守卫**：冻结路径存在、`#miao` 映射有效、全仓相对 import 可解析 |

### 1.3 对上游既有文件的改动

除新增文件外，改动仅限以下 5 个文件，且都有明确理由（便于上游同步时逐项确认）：

| 文件 | 改动 | 原因 |
|---|---|---|
| `package.json` | 新增 `license` / `engines` / `packageManager`；`lint` 改为只读校验并新增 4 个脚本；`devDependencies` 改精确版本 | §2.1、§2.3 |
| `.gitignore` | 白名单补 `!/plugins/example`；补工具链产物忽略 | §2.6 |
| `prettier.config.js` | 增加 `endOfLine: "auto"` | §2.3（CRLF 假阳性） |
| `.puppeteerrc.cjs` | **仅格式化**（prettier）；语义等价（`for` + `try` 结构不变，另补了一处 ASI 防护分号） | 纳入格式闸门 |
| `pnpm-workspace.yaml` | 仅格式化；另 pnpm 自动追加了 `minimumReleaseAgeExclude: [prettier@3.9.9]` | 见下 |

> **关于 `minimumReleaseAgeExclude`**：pnpm 12 默认对过新的包版本设置冷静期（`minimumReleaseAge` 未显式配置），
> 而本次把 `prettier` 钉到了刚发布不久的 `3.9.9`，pnpm 因此自动把该版本写入排除列表。
> **必须保留这一行**——否则每次 `pnpm install` 都会重新写入，且 CI 上的全新安装会因冷静期拿不到该版本。

---

## 2. 待办（阶段 0 剩余工作）

### 2.1 仓库元信息（已完成，含一处调整）

- [x] 增加 `engines.node`
      - **已实测确认**（`npm view <pkg> engines.node`）：`file-type@22` 要求 `>=22`；`puppeteer`（`"*"`，解析到最新）要求 `>=22.12.0`；`chokidar@5` 要求 `>=20.19.0`
      - 结论：`"node": ">=22.12.0"`
- [x] 增加 `.nvmrc`，固定开发版本为 `24.19.0`（与开发机 `node -v` 一致）
- [x] 增加 `packageManager: "pnpm@12.6.0"`
- [x] 增加 `license: "GPL-3.0"`（与仓库根 `LICENSE` 一致）
- [~] `pnpm.overrides` 锁死可漂移的依赖 —— **改为实现方式**。仓库不跟踪 `pnpm-lock.yaml`（`plugins/**` 是 pnpm workspace 成员，用户增删插件会持续改动锁文件），因此改为把 `devDependencies` 全部写成**精确版本**，保证质量闸门不漂移；运行时依赖的 `^` 范围保持不动（改动面过大且不影响闸门稳定性）
- [~] `name` / `version` / `description` / `repository` / `author` —— **暂不改**。`name` 与 `version` 仅用于展示（`lib/config/init.js` 的 `process.title`、`plugins/system/status.js`、`plugins/other/version.js`），而 `#更新` 流程会与上游做版本展示对比；`repository` 在远端地址确定前填写是无效信息。待仓库确定托管地址后再处理

### 2.2 分支与提交规范（已完成）

- [x] 分支模型：`main`（始终可用）+ 短生命周期 `feat/*`、`fix/*`、`chore/*` —— 写入 `AGENTS.md`
- [x] 采纳 Conventional Commits —— `commitlint.config.js` + `.husky/commit-msg`
- [x] `husky` + `lint-staged`：`.husky/pre-commit` 对暂存区文件跑 `prettier --write` + `eslint --fix`
- [x] **已验证（Windows 端到端）**：`git commit` 会触发 `.husky/pre-commit` → `lint-staged` 正常执行；不合规的提交信息被 `.husky/commit-msg` + `commitlint` 拒绝且不产生提交

### 2.3 代码质量闸门（配置完成，基线待登记）

- [x] `lint` 改为**只读校验**
      - 旧写法 `git ls-files '*.js'|xargs prettier --write --list-different` 有两个问题：写模式无法当 CI 闸门；依赖 `xargs`（Windows PowerShell 下不可靠）
      - 新写法 `prettier --check .` + `format: prettier --write .`；靠 `.prettierignore` 排除 `resources/`、`renderers/`、`lib/modules/`、`plugins/miao-plugin/`
- [x] 引入 ESLint（flat config，`eslint.config.js`）
      - 为 L0 注入的全局变量（`Bot` / `logger` / `redis` / `plugin` / `segment` / `Renderer`）声明 `globals`，否则 `no-undef` 会产生海量误报
      - 只开能捕获真实缺陷的规则：`no-unused-vars`（warn）、`no-empty`（allowEmptyCatch）、`no-constant-condition`
      - `no-floating-promises` 属于**类型感知规则**，需要 `typescript-eslint` + 类型信息，推迟到阶段 3 的收紧步骤
- [x] `jsconfig.json` + `checkJs`，范围限定 `lib/` 与 `plugins/{adapter,system,other}/`，排除 `lib/modules` / `renderers` / `miao-plugin`
      - 配置 `"types": ["node"]` 并引入 `@types/node@24.13.6`，使 `process` / `Buffer` 等有类型
- [x] 登记告警/报错基线 → [`baseline/static-analysis.md`](./baseline/static-analysis.md)
      - ESLint：25 问题（16 error / 9 warning）
      - 类型检查：278 处（自有代码；第三方 147 处已由 `scripts/typecheck.mjs` 过滤）
      - 其中记录了 3 个**真实缺陷**：D1 `Bot.debounce` 在 `finally` 中 `return` 吞掉异常；D2 `Milky.js` 的 `data.comment = data.comment` 自赋值；D3 `Bot` Proxy 把 Symbol 属性隐式转字符串会抛异常
- [ ] 数字归零后在 CI 中把 `continue-on-error` 去掉（阶段 3）

### 2.4 CI 骨架（部分完成）

参照 AstrBot `.github/workflows/`（`code-format.yml`、`unit_tests.yml`、`smoke_test.yml`）建立最小集合：

- [x] `ci.yml`：矩阵（Windows + Linux）× Node（22 + 24），跑 `lint`（阻塞）+ `lint:eslint` + `typecheck` + `test`
      - 因为仓库不跟踪锁文件，`setup-node` 的 `cache-dependency-path` 指向 `package.json`
- [x] 统一用 `pnpm`，`pnpm/action-setup` 固定 `12.6.0`
- [x] 设置 `HUSKY=0`，避免 CI 中安装 git hooks
- [~] `smoke.yml` —— **推迟到阶段 2**。原计划"启动一次 `node .` 验证无加载期崩溃"在阶段 0 不可行：`Bot.run()` 会拉起 redis 进程、初始化 puppeteer、等待适配器上线，CI 中无真实账号会挂起；且没有适配器在线时插件栈本就不会被加载。阶段 2 的流水线骨架会提供"注入 fake 事件 + 假适配器"的测试夹具，届时再做真实的加载冒烟测试

### 2.5 标定与诊断基线（部分完成）

- [x] 记录启动耗时与插件加载数量 → [`baseline/startup.md`](./baseline/startup.md)
      - 冷启动 3.37 s / 热启动 2.56 s 到 online；插件 27 个，加载耗时 1.13 s（冷）/ 0.94 s（热）
      - `PluginsLoader.load_time` 记录的是**每个文件的加载耗时**，但它**从未被日志输出**（仅在热更新时用于保留旧值）。当前只有“加载插件[N个]”这一条汇总日志；逐插件耗时需要额外插桩，暂不做
      - 顺带产出运行期观测 O1：插件可能被重复加载（竞态），详见该文档 §3
- [~] 录制真实消息事件样本 → **改为手工构造 fixture**（本环境无可用平台账号）。方案与理由见 [`baseline/startup.md`](./baseline/startup.md) §4，列为阶段 2 的前置任务
- [ ] 记录插件加载失败的当前表现（`packageTips()` 的报错文案）。本次运行无失败案例，需人为构造（如临时移走某个依赖）后再记录

### 2.6 协作文档（基本完成）

- [x] 新增 `AGENTS.md`：环境要求、常用命令、L0 冻结面、破坏性变更登记要求、提交规范、KISS、目录约定、上游同步
- [x] `.gitignore` 复核并修订
      - 白名单补上 `!/plugins/example`（此前靠 `git add -f` 强制跟踪）
      - 补充工具链产物：`/coverage`、`/.husky/_/`、`/dashboard/{node_modules,dist}`、`*.tsbuildinfo`
      - 保留 `/pnpm-lock.yaml` 忽略，并**写明理由**（`plugins/**` 是 workspace 成员）
- [ ] `CONTRIBUTING.md`（可选，若计划接受外部贡献）

---

## 3. 目录约定

```
Work\Yunzai
├─ docs\refactor\          # 本次改造的规划与实践文档
│  ├─ PLAN.md
│  ├─ 00-prep.md ~ 07-*.md
│  └─ 99-compat-and-migration.md
├─ docs\research\          # （预留）对 AstrBot 等参考实现的调研笔记
├─ lib\                    # 内核
├─ plugins\                # 内置与第三方插件
└─ .github\workflows\      # CI
```

约定：

- 改造相关文档一律进 `docs/refactor/`，不散落在仓库根目录；
- 不新增 `*_SUMMARY.md`、`*_REPORT.md` 之类的临时报告文件（沿用 AstrBot 的约定）；
- 参考实现的调研结论若需要长期保留，进 `docs/research/`，且只记录结论与路径，不复制对方源码。

---

## 4. 验收标准

| # | 标准 | 状态 |
|---|---|---|
| 1 | `git diff --stat upstream/main HEAD` 只包含工具链与文档，无功能改动 | ✅ 已确认 |
| 2 | CI 在 Windows 与 Linux × Node 22/24 上均绿灯 | ⏳ 待仓库有远端后首次触发 |
| 3 | `pnpm lint` 为只读校验且退出码可用于 CI | ✅ 已确认（本地通过） |
| 4 | `pnpm lint:eslint` 与 `pnpm typecheck` 可运行，数字已登记为基线 | ✅ 见 [`baseline/static-analysis.md`](./baseline/static-analysis.md) |
| 5 | `pnpm test` 通过 L0 冻结面守卫 | ✅ 5 个用例通过 |
| 6 | `pnpm install` 后可一次通过上述全部命令 | ✅ 已确认 |
| 7 | 一次 `node .` 启动流程在改造前后可复现 | ✅ 见 [`baseline/startup.md`](./baseline/startup.md) |

阶段 0 的剩余工作只剩 §2.5 的两项（事件 fixture 已改为阶段 2 的前置任务；插件加载失败文案待人为构造）。

> **额外收益**：本次启动实测顺带验证了改造仓在引入全部工具链后**仍能正常启动**（27 个插件加载完成、7 个适配器就绪、HTTP 服务可用、优雅关闭可用），
> 且工作树未被运行时产物污染（`config/config/` 与 `dump.rdb` 均已忽略）。

---

## 5. 风险与注意

- **不要一次开太多闸门**：ESLint 与 `checkJs` 首次引入会产生大量告警，需登记基线后按目录逐步收紧，否则会淹没真实问题。
- **`git ls-files` 语义**：现有 `lint` 脚本依赖它避免扫到 `node_modules`，改写时不要退化成 `prettier --check .`。
- **`upstream` 只读**：push 地址被设为 `DISABLE`，如需向本仓推送请先 `git remote add origin <你的仓库>`。
- **`./config` 与 `./data` 被忽略**：改配置相关代码时注意这些目录不在版本控制内，测试数据需另建 fixture。
