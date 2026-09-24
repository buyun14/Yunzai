# 阶段 0：前期准备

> 上游文档：[`PLAN.md`](./PLAN.md) · 下游： [`01-plugin-contract.md`](./01-plugin-contract.md)
> 目标：让改造工作有一个可回滚、可校验、有闸门的起点。

---

## 1. 已完成

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

---

## 2. 待办（阶段 0 剩余工作）

### 2.1 仓库元信息

- [ ] 修订 `package.json`：`name` / `version` / `description` / `repository` / `author` 改为本仓信息
- [ ] 增加 `engines.node`，明确支持的 Node 版本下限
      - 依赖中 `chokidar@^5`、`express@^5`、`file-type@^22` 已不支持旧版 Node
      - **需实测确认**，不要凭印象写版本号（用 `npm view <pkg> engines` 逐个核对）
- [ ] 增加 `.nvmrc` 或 `.node-version` 固定开发版本
- [ ] 增加 `pnpm.overrides` 锁死可漂移的依赖（现状 `prettier: ^3.9.6` 会让 CI 结果漂移；AstrBot 把 ruff 钉死为 `0.15.22`，同理）

### 2.2 分支与提交规范

- [ ] 分支模型：`main`（始终可用）+ 短生命周期 `feat/*`、`fix/*`、`chore/*`
- [ ] 采纳 Conventional Commits（`feat: ` / `fix: ` / `chore: ` / `refactor: ` / `docs: `）
- [ ] `husky` + `commitlint` 做提交信息闸门
- [ ] `husky` + `lint-staged` 在提交时只对暂存区文件做格式化

### 2.3 代码质量闸门

- [ ] `prettier.config.js` 保持现状；`package.json` 的 `lint` 脚本改为**只读校验**
      - 现状：`"lint": "git ls-files '*.js'|xargs prettier --write --list-different"` —— 会改写文件，CI 无法使用
      - 目标：`lint` → `prettier --check`；新增 `format` → `prettier --write`
      - 注意保留 `git ls-files` 的"只处理已跟踪文件"语义，避免扫进 `node_modules`
- [ ] 引入 ESLint（flat config），规则从"能捕获真实缺陷"出发，先开 `no-undef`、`no-unused-vars`、`no-floating-promises` 等
- [ ] `jsconfig.json` + `checkJs`，先只覆盖 `lib/` 与 `plugins/{adapter,system,other}/`，逐步收紧

### 2.4 CI 骨架

参照 AstrBot `.github/workflows/`（`code-format.yml`、`unit_tests.yml`、`smoke_test.yml`）建立最小集合：

- [ ] `ci.yml`：矩阵（Windows + Linux）× Node 版本，跑 `lint` + `typecheck` + `test`
- [ ] `code-format.yml` 等价物：`prettier --check`（与 `ci.yml` 合并亦可）
- [ ] `smoke.yml`：仅启动一次 `node . --help` 或加载全部插件并退出，验证无加载期崩溃
- [ ] 统一用 `pnpm`（仓库已有 `pnpm-workspace.yaml`），CI 中启用缓存

### 2.5 标定与诊断基线

改造前先把"当前行为"量化，否则阶段 2 无法判断是否回归：

- [ ] 记录启动耗时、插件加载数量与耗时（`PluginsLoader.load_time` 已收集，见 `lib/plugins/loader.js`）
- [ ] 录制一批真实消息事件样本（脱敏）作为阶段 2 的金标准回归输入
- [ ] 记录插件加载失败的当前表现（`packageTips()` 的报错文案），改造后需保持一致或更好

### 2.6 协作文档

- [ ] 新增 `AGENTS.md`：构建/运行命令、代码风格、KISS 原则、"禁止新增报告型 md 文件"、发布流程
      - 可直接参考 AstrBot 的 `AGENTS.md`（含 `uv sync` 段、pre-commit 段、KISS 段、docstring 段、release 段）
- [ ] 新增 `CONTRIBUTING.md`（可选，若计划接受外部贡献）
- [ ] `.gitignore` 复核：当前 `plugins/*` 白名单只放行 `adapter/system/other`，`plugins/example` 靠强制跟踪；需在文档中写明新增插件的纳管方式

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

1. `git diff --stat upstream/main HEAD` 在阶段 0 结束时仍为空（除本仓元信息与 `docs/` 外无功能改动）；
2. CI 在 Windows 与 Linux 上均绿灯；
3. `pnpm lint` 为只读校验且退出码可用于 CI；
4. `jsconfig.json` 存在且 `pnpm typecheck` 可运行（允许有已知报错，但需登记数量基线）；
5. 一次 `node .` 启动流程在改造前后可复现（用第 2.5 节的记录对比）。

---

## 5. 风险与注意

- **不要一次开太多闸门**：ESLint 与 `checkJs` 首次引入会产生大量告警，需登记基线后按目录逐步收紧，否则会淹没真实问题。
- **`git ls-files` 语义**：现有 `lint` 脚本依赖它避免扫到 `node_modules`，改写时不要退化成 `prettier --check .`。
- **`upstream` 只读**：push 地址被设为 `DISABLE`，如需向本仓推送请先 `git remote add origin <你的仓库>`。
- **`./config` 与 `./data` 被忽略**：改配置相关代码时注意这些目录不在版本控制内，测试数据需另建 fixture。
