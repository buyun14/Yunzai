# 贡献指南

本仓是 [`trss-yunzai`](https://github.com/TimeRainStarSky/Yunzai) 的**改造仓**，
正在按分阶段计划做架构与工程化重构。

## 先读这两份

| 文档 | 作用 |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | **硬性规则**：L0 冻结面、破坏性变更登记、提交规范、KISS、文档维护……违反即不合并 |
| [`docs/refactor/PLAN.md`](./docs/refactor/PLAN.md) | **总纲与导航**：8 个阶段的目标、现状诊断、ADR、进度总表、各分册入口 |

`AGENTS.md` 是必读的那一份，它同时面向人与 AI 助手。这里只讲流程。

工程实践中踩过的坑（本地绿而 CI 红、覆盖率清单、CLI 的真跑验证……）
集中在 [`docs/refactor/dev-notes.md`](./docs/refactor/dev-notes.md)。

## 环境

| 项 | 要求 |
|---|---|
| Node | `>= 22.12.0`（开发机固定为 `.nvmrc` 的 `24.19.0`） |
| 包管理 | `pnpm@12.6.0`（见 `package.json` 的 `packageManager`） |

```bash
pnpm install
pnpm app          # 启动；需要一个 OneBot 实现作为适配器才会真正收到消息
```

## 质量闸门（提交前必须全绿）

```bash
pnpm lint            # prettier --check .（同时充当语法检查）
pnpm lint:eslint     # eslint .（基线 0 error / 0 warning，只降不升）
pnpm typecheck       # JSDoc + checkJs，自有代码 0 处报错
pnpm test            # vitest run
pnpm test:coverage   # 覆盖率（清单见 03-engineering.md §3.4.1）
pnpm smoke           # 真启动一次，等到 "加载插件[N个]" 后优雅关闭
```

CI 跑同样的命令：`ubuntu` / `windows` × `node 22` / `24` 四条腿，外加独立的 `coverage`
job 和一个**仅 ubuntu** 的 `Smoke`（Windows runner 不支持 service containers，
而 smoke 需要一个 redis 服务容器）。

> ⚠️ **本地绿不等于 CI 绿。** `package.json` 的 `imports` 把 `#miao` 映射到一个
> **gitignore 的**目录，干净克隆与 CI 上的类型检查结论可能不同。改过 `lib/` 或 `types/`
> 之后，按 [`dev-notes.md`](./docs/refactor/dev-notes.md) §4 在干净克隆里跑一遍四个门。

## 提交

Conventional Commits（`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf` /
`build` / `ci`），由 `.husky/commit-msg` + `commitlint` 强制。

**正文里不要用 `##` 标题**——commitlint 会把它当成 footer 并报警告。

## 改动要带文档

状态只写在文档里。一个阶段（或一次有分量的改动）结束后，同步 `PLAN.md` §9 进度总表、
对应分册（`> 落地情况` 块 + 验收勾选）、`99-compat-and-migration.md`（L1 适配与 BCR 登记）
三处；勾选验收项要附**证据**。清单见 [`dev-notes.md`](./docs/refactor/dev-notes.md) §8。

破坏性变更（依赖增删、配置键改名、路径调整）必须**先登记再合入**，见 `AGENTS.md` 规则 2。

## 不要提交

- 真实账号 / 群号 / token / 密钥（本仓公开）；
- `*_SUMMARY.md`、`*_REPORT.md` 之类的临时产物，见 `AGENTS.md` 规则 6；
- 被忽略的运行时目录（`config/config/`、`config/backups/`、`logs/`、`coverage/`、
  `node_modules/` 等，见 `.gitignore`）。别用 `-f` 绕开忽略规则。
