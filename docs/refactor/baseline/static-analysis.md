# 静态分析基线（阶段 0）

记录引入质量闸门时各项检查的真实结果，作为后续收紧的起点。
**以下数字只允许下降**；任何新增报错都应视为回归。

## 0. 摘要

| 闸门 | 命令 | 阶段 0 结果 | CI 中的状态 |
|---|---|---|---|
| 格式化 + 语法 | `pnpm lint` | ✅ 通过 | **阻塞** |
| ESLint | `pnpm lint:eslint` | ❌ 25 问题（16 error / 9 warning） | `continue-on-error` |
| 类型检查 | `pnpm typecheck` | ❌ 278 处（自有代码，第三方 147 处已排除） | `continue-on-error` |
| 单元测试 | `pnpm test` | ✅ 5 通过（L0 冻结面守卫） | **阻塞** |

复现：

```powershell
pnpm lint
pnpm lint:eslint
pnpm typecheck          # 会打印按文件统计
node scripts/typecheck.mjs --json   # 机器可读
pnpm test
```

---

## 1. 引入闸门时的配置决策

| 决策 | 原因 |
|---|---|
| `prettier.config.js` 增加 `endOfLine: "auto"` | 本机 `core.autocrlf=true`，工作区文件是 CRLF，而 prettier 默认 `endOfLine: "lf"` 会把**全部 67 个文件**判为格式不符（假阳性）。根因治理（`.gitattributes` + 统一工作区为 LF）需要单独一次工作区重新检出，留待阶段 3 |
| `.prettierignore` 排除 `*.md` | `README.md` / `CHANGELOG.md` 由上游维护且频繁改动，纳入闸门会让每次上游同步都产生格式冲突 |
| `.prettierignore` 排除 `resources/`、`renderers/`、`lib/modules/`、`plugins/miao-plugin/` | 第三方或 vendored + patch 过的代码，格式化会产生无法上游同步的 diff |
| ESLint 为 L0 全局变量声明 `globals` | 否则 `no-undef` 在内核中会产生海量误报 |
| ESLint 规则只选 `no-unused-vars` / `no-empty` / `no-constant-condition`，其余用 `js.configs.recommended` | 只捕获真实缺陷，不做风格争论（风格交给 Prettier）。`no-floating-promises` 是类型感知规则，需要 `typescript-eslint`，推迟到阶段 3 |
| `jsconfig.json` 的 `lib` 设为 `ES2024` | 代码使用 `Promise.withResolvers`（ES2024），否则产生大量 TS2550 假报错 |
| 新增 `types/globals.d.ts` | 声明运行时注入的 `Bot` / `logger` / `redis` / `plugin` / `segment` / `Renderer` / `start_type`。声明为 `any` 是刻意的——`Bot` 与 `cfg` 本质上是 Proxy |
| 新增 `scripts/typecheck.mjs` 包装 `tsc` | 开启 `checkJs` 后 TypeScript 会把经 import 到达的第三方 `.js`（`node_modules/**`、`plugins/miao-plugin/**`）一并检查；这些不受本仓控制，会让闸门永远无法收敛为零。脚本按路径过滤后只统计自有代码 |

---

## 2. ESLint 基线明细（25）

### 2.1 真实缺陷（应优先修复，且各自需要回归测试）

#### D1 · `lib/util.js:450` · `no-unsafe-finally`

```js
return (async () => {
  try {
    await promise.promise
  } finally {
    return ret.apply(Object.assign({ [debounceTime]: time }, this), args)
  }
})()
```

`finally` 中的 `return` 会**吞掉** `await promise.promise` 抛出的异常，并覆盖 `try` 块的结果。

- 影响面：所有使用 `Bot.debounce` 的插件。被防抖的函数若 reject，异常将静默消失，防抖调用照常走 trailing 分支。
- 修法：把 `return` 移出 `finally`（例如 `try { await promise.promise } catch {}` 之后再 return），或在 `catch` 中显式重新抛出。
- 注意：修改必须配单测，且要覆盖"被防抖函数 reject"的场景。

#### D2 · `plugins/adapter/Milky.js:761` 与 `:794` · `no-self-assign`

```js
data.comment = data.comment
```

无操作语句。从上下文看作者大概率想写兜底值（紧随其后的日志会打印 `${data.comment}`）。

- 影响：`comment` 缺失时日志输出 `undefined`；不会崩溃。
- 修法：确认 Milky 协议字段后改为 `data.comment ??= ""`（需协议文档或实测确认，不要凭猜）。

### 2.2 潜在风险（当前不触发，但依赖隐式不变量）

| # | 位置 | 规则 | 分析 |
|---|---|---|---|
| P1 | `app.js:9` 与 `app.js:21` | `no-fallthrough` | `case "stop"` / `case "daemon"` 没有 `break`，靠块内 `process.exit()` 不返回来终止。当前正确性依赖一条**跨文件隐式契约**：`lib/config/init.js` 会覆盖 `process.exit`（包一层记录退出栈），覆盖后的实现必须仍然不返回。若将来把 `process.exit` 改成可返回或抛异常的实现，`case "stop"` 会穿透到 `case "daemon"` |
| P2 | `plugins/adapter/Satori.js:160,165,169,173,196,443,444` | `no-case-declarations` | `case` 内直接 `const`，没有块作用域。当前各分支变量名不冲突；一旦同名即触发 TDZ 错误 |
| P3 | `lib/plugins/loader.js:259,263` | `no-setter-return` | `defineProperty` 的 setter 用箭头表达式简写（`set: v => (e.game = ...)`），setter 的返回值无意义。功能正常，属可读性问题 |

### 2.3 死代码（可直接清理，无行为影响）

| 位置 | 内容 |
|---|---|
| `.puppeteerrc.cjs:16` | `catch (err) {}` 的 `err` 未使用 + 空块 |
| `lib/bot.js:439`、`lib/bot.js:462` | 未使用的 `id` |
| `lib/config/init.js:48` | 未使用的 `redis` |
| `lib/config/log.js:4` | 未使用的 `fs` import |
| `lib/util.js:273` | 空块 |
| `plugins/adapter/Milky.js:2,5,6` | 未使用的 import：`util`、`fs`、`YAML` |
| `plugins/other/restart.js:2` | 未使用的 import：`spawn` |

### 2.4 已处理的误报

`.puppeteerrc.cjs:31` 的 `no-undef`（`logger`）——该文件用 `typeof logger != "undefined"` 做合法的全局探测，已在 `eslint.config.js` 的 `.cjs` 块中声明该全局。

---

## 3. 类型检查基线（278 处）

### 3.1 按文件分布（Top 10）

| 处数 | 文件 |
|---|---|
| 47 | `lib/bot.js` |
| 35 | `plugins/adapter/Milky.js` |
| 25 | `lib/plugins/plugin.js` |
| 22 | `lib/util.js` |
| 21 | `lib/plugins/loader.js` |
| 14 | `plugins/adapter/Satori.js` |
| 14 | `plugins/other/restart.js` |
| 11 | `lib/config/redis.js` |
| 9 | `lib/plugins/runtime.js` |
| 9 | `lib/tools/web.js` |

### 3.2 按根因分类

| 类别 | 典型报错 | 根因 | 收敛方式 |
|---|---|---|---|
| 动态 Proxy 无类型 | `Property 'server' does not exist on type 'Cfg'`（`lib/bot.js` 约 20 处） | `lib/config/config.js` 用 Proxy 把未知属性变成配置读取，TS 无从推断 | 为 `Cfg` 补索引签名，或补 JSDoc |
| 数组 + `Object.assign` 扩展方法 | `Property 'now' / 'length' / 'slice' does not exist on type '{ toJSON() ... }'`（`lib/bot.js` 约 10 处） | `uin` 是数组并用 `Object.assign` 挂方法 | 抽为独立类型声明 |
| 手写 stub 与第三方类型不兼容 | `Type 'FSWatcher' is missing ...`（`lib/config/config.js:36`） | `lib/config/config.js` 里手写了 `FSWatcher` 空实现类替换 `chokidar`，与真实类型不兼容 | 用 `// @ts-expect-error` 并注明原因 |
| 默认参数丢失 arity 信息 | `lib/bot.js:602` `Expected 0 arguments, but got 1` | 函数签名里 `fnc` 的默认值让 TS 推断为 0 参，而函数体内会重新赋值调用 | 补 JSDoc 参数类型 |
| **疑似缺陷（见下）** | `lib/bot.js:88`、`lib/bot.js:92` `Implicit conversion of a 'symbol' to a 'string'` | 见 §3.3 | — |

### 3.3 类型检查顺带发现的缺陷

#### D3 · `lib/bot.js:88` 与 `lib/bot.js:92` · Symbol 隐式转字符串

```js
util.makeLog("trace", `因不存在 Bot.${prop} 而重定向到 Bot.${i}.${prop}`)
// ...
util.makeLog("trace", `不存在 Bot.${prop}`)
```

`Bot` 的 Proxy `get` 陷阱里，`prop` 可能是 **Symbol**（例如框架或插件用 `Bot[Symbol.iterator]`、`Bot[Symbol.toStringTag]` 做探测）。模板字符串对 Symbol 求值会抛
`TypeError: Cannot convert a Symbol value to a string`。

- 影响：不是"日志打不出来"，而是**访问不存在的 Symbol 属性时直接抛异常**，且抛在 Proxy 内部，堆栈会误导排查方向。
- 修法：改为 `String(prop)`（`lib/bot.js:88` 与 `:92` 两处）。
- 这条同时说明：类型检查虽然噪声大，但确实能发现 ESLint 覆盖不到的问题。

---

## 4. 收紧计划（阶段 3）

按"投入产出"排序，每步都要把对应数字降下来并在同一 PR 更新本文件：

1. 清理 §2.3 的死代码（无行为影响，可一次性完成）。
2. 修复 D1 / D2 / D3，各自配单测（D1 必须覆盖 reject 场景）。
3. 引入 `typescript-eslint` 并开启类型感知规则（`no-floating-promises`），这需要先降低类型噪声。
4. 收敛 §3.2 的四类类型噪声，按目录推进：`lib/pipeline/` → `lib/plugins/` → `lib/message/` → `lib/config/` → `lib/bot.js`。
5. 数字归零后，把 CI 中 `lint:eslint` 与 `typecheck` 的 `continue-on-error` 去掉。
6. 处理 §2.2 的 P1/P2/P3（可选择加块作用域、补 `break`），并同步更新 `99-compat-and-migration.md` 中的隐式契约说明。

---

## 5. 已知未处理项

| 项 | 说明 |
|---|---|
| `core.autocrlf=true` 导致的 CRLF/LF 不一致 | 已用 prettier `endOfLine: "auto"` 绕过；根因治理需要新增 `.gitattributes` 并把工作区统一为 LF（需一次工作区重新检出），未在阶段 0 处理 |
| `plugins/miao-plugin` 与 `node_modules` 的 147 处类型报错 | 不受本仓控制，由 `scripts/typecheck.mjs` 过滤，不计入闸门 |
| `sequelize` / `sqlite3` 死依赖 | `pnpm install` 仍会安装（501 个包）。去留决策见 `05-persistence-config.md` 的开放问题 Q1 |
