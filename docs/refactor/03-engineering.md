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

#### 3.4.1 覆盖率（阶段 3 落地）

**统计范围只含「改造涉及的核心模块」**，配在 `vitest.config.js` 的 `coverage.include`：

```
lib/pipeline/**/*.js   lib/event-bus.js
lib/message/**/*.js    lib/adapter/**/*.js      ← 阶段 4 补入
lib/config/{version,backup,migrate}.js  lib/config/migrations/*.js   ← 阶段 5 §3.1 补入
lib/plugins/{schema,metadata,version,plugin-config,rule}.js
```

为什么不全仓统计：`lib/` 下大量代码是 vendored 第三方与
puppeteer / 渲染 / 适配器等需要真实环境才能跑的模块，
把它们算进来只会得到一个很大的分母和一个没指导意义的百分比。
上面这份清单是「各阶段改动过、且有单测覆盖」的文件——
它们是后续重构最可能碰坏的地方。

> ⚠️ **教训：每完成一个阶段都要回来补这份清单。**
> 阶段 4 收尾时才发现 `lib/message/` 与 `lib/adapter/` 两个新目录
> **没有被任何 glob 覆盖**——它们可以掉到 0% 而 CI 依旧全绿。
> 门槛没覆盖到的代码，等于没有门槛。补进去之后两个目录的实测是
> `lib/message` 100 / 96.61 / 100 / 100，`lib/adapter` 97.43 / 92.85 / 100 / 96.77。
> 阶段 5 §3.1 又出了同样的事（`lib/config/` 没进清单），这次按“改动过、且有单测覆盖”
> 的原文只挑那几个文件加（`config.js` / `init.js` / `redis.js` 需要真实环境，
> 整目录加进来只会得到一个大分母），实测 100 / 93.75 / 100 / 100。
>
> 换句话说：**新增目录要回来补清单，新增文件也要。**

**基线（2026-09-24，阶段 5 §3.1 后，共 500 个用例）**：

| 指标 | 实测 | 门槛 |
|---|---|---|
| Statements | 95.87% | 93 |
| Branches | 90.67% | 88 |
| Functions | 95.80% | 93 |
| Lines | 97.42% | 95 |

（更早的两次基线：阶段 4 完成后是 95.83 / 90.84 / 95.23 / 97.06；
补入阶段 4 的两个目录之前是 95.39 / 90.15 / 94.23 / 96.84。）

门槛取实测值下浮 2 个点，**意图是「只允许下降不允许回归」而不是追求精度**：
贴着实测值会让「合理地新增一小段尚未测到的代码」直接卡死 CI，
反而逼出「为了过门槛而凑测试」——那正是本节开头警惕的东西。

**本步顺带把 `plugin-config.js` 从 61.5% 拉到 94.9%**（行覆盖 100%）。
差的那部分全是 `problems` 的错误上报分支，也就是
「用户怎么知道自己把配置写坏了」的路径，值得一测。

> **已知缺口**：`plugin-config.js` 仍有两条分支未覆盖——
> `metadata.config.defaults` 命中、以及 schema 校验失败（`配置校验失败 →`）。
> 它们需要 `plugins/<目录>/` 下**真实存在**的文件，而测试里
> **刻意不在 `plugins/` 下造临时目录**：`PluginsLoader.load()` 会扫描该目录，
> 一个残留的临时目录会污染真实启动与 CI 冒烟。
> 归口阶段 5（配置持久化本身就在它的重写范围内），届时那两条分支应当随重构一并处理。

### 3.5 提交与分支

- `husky` + `lint-staged`：提交前对暂存文件跑 `eslint` + `prettier --write`；
- `commitlint` + Conventional Commits：`feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf`；
- 分支：`main` 始终可用，改动走 `feat/*` 短分支。

> **偏差记录（已关闭）：阶段 0 起提交钩子里不跑 ESLint。**
> `eslint` 的退出码包含**基线里已有的**报错，不区分是否本次引入。
> 阶段 0 记录的 16 个 error 里有几个位于改造必须反复触碰的文件
> （`lib/plugins/loader.js` 的 `no-setter-return`、`lib/bot.js` 的 Symbol 转换、`app.js` 的 `no-fallthrough`），
> 实测一旦把 eslint 放进钩子，这些文件就 **任何改动都无法提交**（阶段 1 第一次提交即被拦住）。
>
> **关闭时间：阶段 3 第 8 步。** `baseline/static-analysis.md` 的 ESLint 数字已归零
> （16 error / 9 warning → 0 / 0），前提条件随之消失，于是：
> `lint-staged.config.js` 加回 eslint、`ci.yml` 去掉 `lint:eslint` 的 `continue-on-error`。
> `typecheck` 的 `continue-on-error` 也已在同一步去掉：自有代码报错已随第 8 步归零（270 → 0）。

### 3.6 CI

参考 AstrBot 的 workflow 拆分（`code-format.yml`、`unit_tests.yml`、`smoke_test.yml`、`coverage_test.yml`、`codeql.yml`），本仓收敛为 3 个：

| workflow | 触发 | 内容 | 状态 |
|---|---|---|---|
| `ci.yml` | push / PR | 矩阵 `os: [ubuntu-latest, windows-latest]` × `node: [22, 24]`；步骤 `pnpm i` → `lint` → `lint:eslint` → `typecheck` → `test` | ✅ 已落地 |
| `ci.yml` 的 `coverage` job | push / PR | 单个组合（ubuntu / node 24）跑 `pnpm test:coverage`；门槛见 §3.4.1 | ✅ 已落地 |
| `smoke.yml` | push / PR | 单组合（ubuntu / node 24 + redis service）跑 `pnpm smoke`：真的启动一次，跑到"插件加载完成"，再让它优雅退出 | ✅ 已落地 |
| `codeql.yml` | 定时 + push | JavaScript/TypeScript 静态安全扫描（AstrBot 亦有此项） | ⬜ 未开始 |

> **矩阵里 `node` 取 `[22, 24]` 而不是 `[20, 22]`**：本项目的 `engines.node` 是 `>=22.12.0`
> （由 `file-type@22` 的 `>=22`、`puppeteer` 的 `>=22.12.0` 实测推导而来），
> 跑 node 20 只会得到一堆无关的失败。

> **首次真实 CI 结果（2026-09-24，`286d823`）：全部绿灯。**
> `coverage` ✅、`ubuntu-latest / node 22` ✅、`ubuntu-latest / node 24` ✅、
> `windows-latest / node 22` ✅、`windows-latest / node 24` ✅、`smoke` ✅。
>
> 第一轮并不绿：四条矩阵腿全挂在 `Typecheck` 步，而本地是 0 处。**根因是闸门本身
> 依赖了「本机装了 miao-plugin」这个环境事实**——`#miao` 指向被 gitignore 的第三方插件，
> 干净克隆与 CI 里解析不到，报 TS2307 共 5 处。修法与复现方式见
> [`baseline/static-analysis.md`](./baseline/static-analysis.md) §3.6。
>
> 这次还顺带证实了一件此前只是“推演”的事：CI 步骤是顺序的，前一步失败后后续几步
> **不会执行**。所以那几轮里 `pnpm test` 与 `pnpm smoke` 其实从未真正跑过——
> “CI 有那个步骤”不等于“CI 跑过那个步骤”。

> **偏差记录：`smoke.yml` 推迟了两次，最后是这样落地的。**
> 阶段 0 无可行的启动方式：`Bot.run()` 会拉起 redis 进程、初始化 puppeteer、等待适配器上线，
> CI 中无真实账号会挂起。当时计划等阶段 2 的夹具就位后补；阶段 2 结束时夹具已就位，
> 但**又冒出一个新障碍**：`lib/config/redis.js` 连不上时会 `spawn` 一个 redis 二进制，
> CI runner 上没有它，而 `redisInit` 传了 `exit=true`，失败即 `Bot.exit()`，是硬失败。
>
> 最终方案：**给 smoke job 挂一个 `redis:7-alpine` service container**（正好发布到
> 默认配置的 `host=127.0.0.1 / port=6379`），于是走"连接成功"分支、`spawn` 永不触发。
> 附带结果是作业只能跑在 ubuntu 上（windows runner 不支持 service container）——
> 可以接受，因为冒烟验证的是与 OS 无关的失败，OS 差异由 `ci.yml` 的 4 个组合覆盖。
>
> **落地时被实测改掉的两个设计**（原计划想当然的地方）：
>
> 1. 原计划"看到 `加载插件[N个]` 后 `GET /exit` 再断言退出码为 0"。
>    实测发现 `app.js` 的 `stop` → `Bot.serverExit()` → `Bot.exit(1)`，
>    也就是**优雅停止与崩溃的退出码都是 1**，退出码根本不能当判据。
>    最终判据是日志：必须出现 `加载插件[N个]` 且 N > 0。
> 2. 脚本在启动前**必须先探测端口是否空闲**：`Bot.serverEADDRINUSE()` 会向该端口发
>    `/exit` 去挤掉占用者，如果本地正跑着一个实例，冒烟会把它关掉。宁可提前退出。
>
> 详情见 `scripts/smoke.mjs` 的文档注释；它同时也登记了自身局限——
> 只回答"能不能起来"（判失败的是模块解析失败 / 插件加载超时 / 未捕获异常三类信号），
> 适配器连不上平台产生的 `[ERRO]` 只统计、不判失败，因为一个长期因环境而红的冒烟等价于没有冒烟。

两个从 AstrBot 借来的细节：

1. **`continue-on-error` 用于平台差异**：AstrBot 的 `unit_tests.yml` 中 Windows 作业是允许失败的。本项目的 puppeteer/截图相关测试在 CI 中天然脆弱，同样应先在 Windows 上设 `continue-on-error: true`，等稳定后再收紧。
2. **版本注入**：AstrBot 的 `dashboard_ci.yml` 会把 commit SHA 注入构建产物。本仓若做 WebUI，同样应在构建时注入版本，便于线上排查。

---

## 4. 实施步骤

| 步 | 内容 | 可独立提交 | 状态 |
|---|---|---|---|
| 1 | 新增 `.prettierignore`；`lint` 改为 `--check`，新增 `format` | ✅ 立即改善 | ✅ 阶段 0 |
| 2 | 引入 ESLint + globals 声明，跑一次全量，**记录告警数基线** | ✅ | ✅ 阶段 0（16 error / 9 warning） |
| 3 | 新增 `jsconfig.json`（`checkJs` 开启，`strict` 关闭），跑一次，记录报错数基线 | ✅ | ✅ 阶段 0（278 → 阶段 2 末为 270） |
| 4 | 引入 vitest，先写 3 个纯函数测试（`schema.js` 校验器最合适） | ✅ | ✅ 阶段 0 起，阶段 2 扩到 348 用例 |
| 5 | `husky` + `lint-staged` + `commitlint` | ✅ | ✅ 阶段 0 |
| 6 | 新增 `ci.yml`（先只跑 lint + test，typecheck 设 `continue-on-error`） | ✅ | ✅ 阶段 0 |
| 6a | **覆盖率**：登记基线 → 设门槛 → 接进 CI | ✅ | ✅ 阶段 3（见 §3.4.1） |
| 7 | 新增 `smoke.yml` | ✅ | ✅ 阶段 3（redis service + `scripts/smoke.mjs`） |
| 8 | 收紧：按目录消除 ESLint 告警与 TS 报错，逐目录把 `continue-on-error` 去掉 | 逐步 | ✅ **已全部归零**：ESLint 16/9 → 0/0；typecheck 270 → **0**；两者均已转阻塞 |

---

## 5. 验收标准

- [x] `pnpm lint` 为只读校验，在 Windows 与 Linux 上结果一致
- [x] `.prettierignore` 生效：修改 `lib/modules/` 下任何文件都不会被格式化
- [x] `pnpm lint:eslint` **零问题**并作为阻塞项：阶段 3 第 8 步从 16 error / 9 warning 清到 0/0，
      提交钩子与 CI 均已转为阻塞；逐条处理方式见 `baseline/static-analysis.md` §0.1
- [x] `pnpm typecheck` **零报错**并作为阻塞项：阶段 3 第 8 步从 270 处清到 0，
      CI 的 `continue-on-error` 已去掉；收敛过程与四类根因见 `baseline/static-analysis.md`
- [x] `pnpm test` 至少覆盖：`lib/plugins/schema.js` 校验器、调度器递回逻辑、`RateLimit` 拆分的两个 Stage
- [x] **覆盖率**：核心模块 95.83% / 90.84% / 95.23% / 97.06%（阶段 4 完成后），
      门槛已入 `vitest.config.js` 并在 CI 里阻塞（`03-engineering.md` §3.4.1）
- [x] `smoke.yml` 跑通：本地实测加载插件 27 个 / 适配器 7 个 / 监听 5 个，
      随后通过 `node . stop` 优雅退出；失败路径也实测过（无孤儿进程、无残留 redis）。
      **已在真实 runner 上连续三次成功**（ubuntu + `redis:7-alpine` service container）
- [x] `ci.yml` 在 Windows 与 Linux matrix 上均绿灯：`286d823` 上 `coverage`、
      `ubuntu-latest / node 22`、`ubuntu-latest / node 24`、`windows-latest / node 22`、
      `windows-latest / node 24` 五条全部 success，且四条矩阵腿的
      `Format check` / `ESLint` / `Typecheck` / `Test` 逐步均为 success。
      第一轮并不绿——四条腿全挂在 `Typecheck`（本地闸门则全绿），
      根因与修法见 [`baseline/static-analysis.md`](./baseline/static-analysis.md) §3.6
- [x] 提交不符合 Conventional Commits 时被 `commitlint` 拒绝（阶段 0 已实测）
- [x] `pnpm i` + 全部门在干净克隆上可一次通过（无隐式环境依赖）
      —— **首次实测就抓到一处违规**：`frozen-surface.test.js` 无条件断言
      `#miao` 的目标文件存在，而 `miao-plugin` 是 gitignore 的第三方插件，
      干净克隆与 CI 里都没有，会直接红。已改为两层断言（映射字符串逐字固定，
      文件存在性仅在插件已安装时校验）。
      —— **第二次抓到的是我自己漏项的检查方式**：当时只在克隆里跑了 `pnpm test`，
      没跑 `typecheck`，于是 `#miao` 在 CI 上报 TS2307、在本机不报这件事被判门漏过，
      直到真的推上 GitHub 跑 CI 才暴露。教训：**“干净克隆”必须跑全部四个门**，
      不能只跑最熟悉的那一个。

---

## 6. 风险

| 风险 | 对策 |
|---|---|
| 首次引入 ESLint/`checkJs` 产生数百条报错，淹没真实问题 | 先跑通、登记基线、再按目录收敛；CI 中逐步把 `continue-on-error` 去掉 |
| 测试为通过而通过（断言过弱） | 优先测"决策序列"这类有明确语义的对象；阶段 2 的金标准对比测试必须真实断言输出 |
| Windows CI 上 puppeteer/截图不稳定 | 相关测试单独标记，`continue-on-error`；不阻塞主流程 |
| 为可测性而重构生产代码，导致 diff 失控 | 用 `vi.stubGlobal` 隔离；生产代码只在阶段 2/4 的既定改造中变动 |
| `typecheck` 变成摆设（长期全红） | 基线只允许下降，PR 中若新增报错则 CI 失败 |
