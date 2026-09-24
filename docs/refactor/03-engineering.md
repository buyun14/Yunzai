# 阶段 3：工程化

> 上游：[`02-pipeline.md`](./02-pipeline.md) · 下游：[`04-message-adapter.md`](./04-message-adapter.md)
> 参考实现：AstrBot `.github/workflows/`、`tests/`、`pyproject.toml` 的 `[tool.ruff]`、`.pre-commit-config.yaml`

## 1. 目标

把"没有安全网"变成"每一步改动都有闸门"。这一阶段本身不改变运行时行为，是后续所有阶段的前置条件。

## 2. 现状

| 项 | 现状 | 问题 |
|---|---|---|
| 测试 | 无 `tests/` 目录 | 重构无法验证是否回归 |
| CI | 仓库无 `.github/` | 无自动闸门 |
| 类型 | 无 `tsconfig.json` / `jsconfig.json` | 跨文件重构（改名、改签名）只能靠人工搜索 |
| 格式化 | 仅 `prettier.config.js` | — |
| `lint` 脚本 | `git ls-files '*.js' \| xargs prettier --write --list-different` | ① 是**写模式**，不能当 CI 闸门；② 依赖 `xargs`，在 Windows PowerShell 下不一定可用（当前仓库主要在 Windows 上开发） |
| 提交规范 | 无 | `CHANGELOG.md` 靠人工维护 |

---

## 3. 设计

### 3.1 格式化与 lint 脚本（先修这个）

**不要**继续用 `git ls-files | xargs` 的组合，改为跨平台写法：

```jsonc
// package.json scripts
{
  "lint": "prettier --check .",
  "format": "prettier --write .",
  "lint:eslint": "eslint .",
  "typecheck": "tsc -p jsconfig.json --noEmit",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

依赖两个前提：

1. Prettier 默认尊重 `.gitignore`，因此不会扫 `node_modules`；
2. 新增 `.prettierignore` 明确排除**第三方代码**：

```
resources/
renderers/
lib/modules/
plugins/miao-plugin/
plugins/*/node_modules/
```

> `lib/modules/` 下是 vendored + patch 过的第三方包（`lodash`、`md5`、`node-fetch`、`oicq`、`*.patch`），`renderers/shotium` 同理。对它们做格式化会产生无法上游同步的 diff。

### 3.2 ESLint（flat config）

规则选取原则：**只开能捕获真实缺陷的规则**，不做风格争论（风格交给 Prettier）。

| 规则 | 目的 |
|---|---|
| `no-undef` | 捕获拼写错误的全局（本项目大量使用 `Bot`、`logger`、`segment` 等全局） |
| `no-unused-vars` | 捕获失效代码（如 `lib/plugins/handler.js` 中已被注释禁用的 `callAll`） |
| `no-floating-promises`（需 `typescript-eslint`） | 捕获漏 `await` 的异步调用——本项目大量 async，这条价值极高 |
| `no-async-promise-executor` | — |
| `no-empty` / `no-empty-function` | 捕获 `catch {}` 掩盖错误 |

第一步需要为全局变量声明 `globals`（`Bot`、`logger`、`segment`、`plugin`、`redis`…），否则 `no-undef` 会产生海量误报。

### 3.3 类型检查（JSDoc + `checkJs`）

**不重写为 TypeScript**（ADR-004）。做法：

1. 新增 `jsconfig.json`：

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "checkJs": true,
    "allowJs": true,
    "noEmit": true,
    "strict": false,          // 先关，避免一次性爆炸
    "noImplicitAny": false     // 同上
  },
  "include": ["lib/**/*.js", "plugins/system/**/*.js", "plugins/other/**/*.js"],
  "exclude": ["lib/modules/**", "node_modules"]
}
```

2. 分目录推进顺序：`lib/pipeline/` → `lib/plugins/` → `lib/message/` → `lib/config/` → `lib/bot.js`。
3. 无法收敛的动态魔法（`lib/bot.js` 的 Proxy、`lib/config/config.js` 的 Proxy）允许文件级 `// @ts-nocheck`，但必须**登记数量基线**，基线只允许下降。

### 3.4 测试

**框架选 vitest**：原生支持 ESM（本项目 `"type": "module"`）、无额外转译配置、`expect`/mock/coverage 内置。

目录约定（对齐 AstrBot 的"单文件单主题"）：

```
tests/
├─ unit/
│  ├─ pipeline/scheduler.test.js
│  ├─ pipeline/stages/rate-limit.test.js
│  ├─ plugins/schema.test.js
│  └─ message/parse.test.js
├─ integration/
│  ├─ plugin-load.test.js
│  └─ pipeline-order.test.js
└─ fixtures/
   ├─ events/          # 阶段 0 录制的脱敏事件样本
   └─ plugins/         # 用于测试的最小插件
```

关键约束：

- **优先测纯函数**：`lib/plugins/schema.js`（校验器）、`lib/message/parse.js`（解析）、调度器的递归逻辑——这些都不需要启动 Bot；
- 需要全局 `Bot` 的模块用 `vi.stubGlobal("Bot", fakeBot)`，不要为了可测性去改生产代码的结构；
- 覆盖率**先登记基线再设门槛**，不要一开始就设 80% 导致大量无效测试。

### 3.5 提交与分支

- `husky` + `lint-staged`：提交前只对暂存文件跑 `prettier --write` + `eslint --fix`；
- `commitlint` + Conventional Commits：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf`；
- 分支：`main` 始终可用，改动走 `feat/*` 短分支。

### 3.6 CI

参考 AstrBot 的 workflow 拆分（`code-format.yml`、`unit_tests.yml`、`smoke_test.yml`、`coverage_test.yml`、`codeql.yml`），本仓收敛为 3 个：

| workflow | 触发 | 内容 |
|---|---|---|
| `ci.yml` | push / PR | 矩阵 `os: [ubuntu-latest, windows-latest]` × `node: [20, 22]`；步骤 `pnpm i` → `lint` → `lint:eslint` → `typecheck` → `test` |
| `smoke.yml` | push / PR | 3 个 OS 上跑一次"启动并加载全部插件后退出"，捕获加载期崩溃 |
| `codeql.yml` | 定时 + push | JavaScript/TypeScript 静态安全扫描（AstrBot 亦有此项） |

> **偏差记录**：原计划的第三个 workflow `smoke.yml`（启动一次并加载全部插件后退出）已**推迟到阶段 2**。
> 阶段 0 无可行的启动方式：`Bot.run()` 会拉起 redis 进程、初始化 puppeteer、等待适配器上线，CI 中无真实账号会挂起；
> 且没有适配器在线时插件栈本就不会被加载。阶段 2 的假适配器 + fake 事件夹具就位后再补。

两个从 AstrBot 借来的细节：

1. **`continue-on-error` 用于平台差异**：AstrBot 的 `unit_tests.yml` 中 Windows 作业是允许失败的。本项目的 puppeteer/截图相关测试在 CI 中天然脆弱，同样应先在 Windows 上设 `continue-on-error: true`，等稳定后再收紧。
2. **版本注入**：AstrBot 的 `dashboard_ci.yml` 会把 commit SHA 注入构建产物。本仓若做 WebUI，同样应在构建时注入版本，便于线上排查。

---

## 4. 实施步骤

| 步 | 内容 | 可独立提交 |
|---|---|---|
| 1 | 新增 `.prettierignore`；`lint` 改为 `--check`，新增 `format` | ✅ 立即改善 |
| 2 | 引入 ESLint + globals 声明，跑一次全量，**记录告警数基线** | ✅ |
| 3 | 新增 `jsconfig.json`（`checkJs` 开启，`strict` 关闭），跑一次，记录报错数基线 | ✅ |
| 4 | 引入 vitest，先写 3 个纯函数测试（`schema.js` 校验器最合适） | ✅ |
| 5 | `husky` + `lint-staged` + `commitlint` | ✅ |
| 6 | 新增 `ci.yml`（先只跑 lint + test，typecheck 设 `continue-on-error`） | ✅ |
| 7 | 新增 `smoke.yml` | ✅ |
| 8 | 收紧：按目录消除 ESLint 告警与 TS 报错，逐目录把 `continue-on-error` 去掉 | 逐步 |

---

## 5. 验收标准

- [ ] `pnpm lint` 为只读校验，在 Windows 与 Linux 上结果一致
- [ ] `.prettierignore` 生效：修改 `lib/modules/` 下任何文件都不会被格式化
- [ ] `pnpm lint:eslint` 通过（或全部剩余告警已登记为基线且有 issue 跟踪）
- [ ] `pnpm typecheck` 可运行，报错数量已登记基线
- [ ] `pnpm test` 至少覆盖：`lib/plugins/schema.js` 校验器、调度器递归逻辑、`RateLimit` 拆分的两个 Stage
- [ ] `ci.yml` 在 Windows 与 Linux matrix 上均绿灯
- [ ] 提交不符合 Conventional Commits 时被 `commitlint` 拒绝
- [ ] `pnpm i` + `pnpm test` 在干净克隆的仓库上可一次通过（无隐式全局状态依赖）

---

## 6. 风险

| 风险 | 对策 |
|---|---|
| 首次引入 ESLint/`checkJs` 产生数百条报错，淹没真实问题 | 先跑通、登记基线、再按目录收敛；CI 中逐步把 `continue-on-error` 去掉 |
| 测试为通过而通过（断言过弱） | 优先测"决策序列"这类有明确语义的对象；阶段 2 的金标准对比测试必须真实断言输出 |
| Windows CI 上 puppeteer/截图不稳定 | 相关测试单独标记，`continue-on-error`；不阻塞主流程 |
| 为可测性而重构生产代码，导致 diff 失控 | 用 `vi.stubGlobal` 隔离；生产代码只在阶段 2/4 的既定改造中变动 |
| `typecheck` 变成摆设（长期全红） | 基线只允许下降，PR 中若新增报错则 CI 失败 |
