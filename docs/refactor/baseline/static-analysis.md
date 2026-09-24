# 静态分析基线（阶段 0）

记录引入质量闸门时各项检查的真实结果，作为后续收紧的起点。
**以下数字只允许下降**；任何新增报错都应视为回归。

> §2 与 §3 保留的是**采集当时**的分析原文（含逐条根因与修法建议），
> 不随后续进展改写；处理结果统一记在下面的 §0.1。

## 0. 摘要

| 闸门 | 命令 | 阶段 0 结果 | 阶段 3 第 8 步后 | CI 中的状态 |
|---|---|---|---|---|
| 格式化 + 语法 | `pnpm lint` | ✅ 通过 | ✅ 通过 | **阻塞** |
| ESLint | `pnpm lint:eslint` | ❌ 25 问题（16 error / 9 warning） | ✅ **0 问题** | **阻塞**（原 `continue-on-error`） |
| 类型检查 | `pnpm typecheck` | ❌ 278 处（自有代码，第三方 147 处已排除） | ✅ **0 处** | **阻塞**（原 `continue-on-error`） |
| 单元测试 | `pnpm test` | ✅ 5 通过（L0 冻结面守卫） | ✅ 352 通过 | **阻塞** |

复现：

```powershell
pnpm lint
pnpm lint:eslint
pnpm typecheck          # 会打印按文件统计
node scripts/typecheck.mjs --json   # 机器可读
pnpm test
```

## 0.1 阶段 3 第 8 步的处理结果

ESLint 基线已清零，处理方式**逐条不同**——凡是有行为风险的都不"顺手改掉"：

| 项 | 处理 | 说明 |
|---|---|---|
| §2.3 死代码（11 条） | ✅ 清理 | 唯一需要小心的是 `lib/config/init.js:48`：去掉绑定但**保留调用**，它的副作用才是重点 |
| P3 · `no-setter-return` | ✅ 改为块体 setter | 与阶段 2 在 `pipeline/stages/process.js` 的同类修复保持一致 |
| P2 · `no-case-declarations` | ✅ 加块作用域 | 各分支同时消除了同名 `const` 的 TDZ 隐患 |
| P1 · `no-fallthrough` | ✅ 补 `break` | 两处的 `break` 都不可达（前一行是 `process.exit()`）；写上是为了标明意图，并让将来把 exit 改成可返回实现时仍然正确 |
| D2 · `no-self-assign` | ✅ 删除自赋值 | **没有**顺手加 `??= ""` 兜底——那需要先确认 Milky 协议，属于"不要凭猜"的范围 |
| D1 · `no-unsafe-finally` | ✅ 改写 + 补单测 | 见下 |
| D3 · Symbol 隐式转字符串 | ✅ 已修 + 配单测 | 见 §3.3；测试 `tests/unit/bot-proxy.test.js`（去掉 `String(prop)` 会立刻变红） |

同一轮的**类型检查**进展（270 → 0，已转阻塞）：

| 项 | 处理 | 说明 |
|---|---|---|
| `Cfg` 缺 9 个动态配置组（100 处） | ✅ 补交叉类型 | 见 §3.5 |
| TS8032 点号 `@param`（30 处） | ✅ 改为描述列表 | 见 §3.4；这一处的“看似零风险”是假的 |
| D3 Symbol 隐式转字符串（3 处） | ✅ `String(prop)` + 单测 | 真缺陷，见 §3.3 |

### D1 的两处修正

**改写**（`lib/util.js` 的 `debounce`）：把 `finally { return ... }` 改成
`catch {}` 之后再 `return`。`catch` 里写明这是**保留原行为**而不是修 bug：

> 需要澄清的是，原文对 D1 的影响面判断**偏重了**。实测（`tests/unit/util/debounce.test.js`）
> 表明异常并非"静默消失"：首次调用方直接 `await promise.promise`，
> rejection 照常抛给他；只有**排队的那一次**会被 `finally` 里的 return 换成重试。
> 是否要改成向排队方也传递异常属于语义变更，需单独评估。

**为什么必须补单测**：改写是在动一个所有插件共用的并发工具，没有测试的"行为等价"
只是一句声明。实测过程中还顺带固定了两条容易被误读的既有行为：

- 裸调用时**首个调用的实际延时是 0**，不是第二个参数的默认值 5000
  （`this?.[debounceTime] ?? 0` 里的 `this` 是 `ret` 被调用时的 this，
  真实用法 `configSave()` 是裸调用）。仅排队重试那次才带上闭包的 5000。
- 首个调用方的 rejection 可观测（见上）。

这两条都**只记录、不修正**，因为改时序同样属于语义变更。

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
- 修法：改为 `String(prop)`（`lib/bot.js:88` 与 `:92` 两处）。**已于阶段 3 第 8 步修复**，
  并由 `tests/unit/bot-proxy.test.js` 锁住（去掉 `String(prop)` 后两个用例立刻因
  `TypeError: Cannot convert a Symbol value to a string` 变红）。
- 这条同时说明：类型检查虽然噪声大，但确实能发现 ESLint 覆盖不到的问题。

#### D4 · `lib/tools/web.js` · `pnpm web` 因缺依赖跑不起来（上游同样如此）

`lib/tools/web.js` 顶部 `import template from "express-art-template"`，
而 `package.json` 里**没有**这个包（只有 `art-template`）——上游
`Own/Yunzai/package.json` 同样没有，`scripts.web` 同样指向这个文件。
也就是说 `pnpm web`（模板调试页）现在一启动就报 module not found。

- 本次只做**类型处理**：把路径断言成 `string`，让 TS 不再报 TS2307。
  **没有**装依赖，也没有把它改成"可选用法 + 友好报错"——那是功能决策，
  不属于本轮收紧的范围。
- 去留归**阶段 6**：那一阶段本来就要重做这个调试页（它做的事是"把 temp/ViewData
  里的渲染数据配着模板页面调出来看"）。
- 记在这里是因为：这条只有靠类型检查（或真的去跑 `pnpm web`）才会暴露，
  而它已经静静地坏了一段时间。

#### D5 · `plugins/adapter/OPQBot.js` · raw 消息分支必然抛 ReferenceError（已修）

```js
case "raw":
  for (const i in i.data) message[i] = i.data[i]
```

循环变量 `i` **遮蔽**了外层的消息段 `i`，而循环头里求值的 `i.data` 读的正是那个
尚未初始化的内层绑定——走到这个分支必然抛
`ReferenceError: Cannot access 'i' before initialization`。
也就是说 OPQBot 发"raw 段"这条路径**从来没成功过**。

- 已修：循环变量改名 `key`。这是本次唯一一处"从崩溃改成能跑"的修改。
- 触发面窄（OPQBot 且消息里含 raw 段），所以一直没被发现。

#### D6 · `plugins/adapter/Satori.js` · 4 个被调用但从未实现的方法

`pickFriend` / `pickMember` / `pickGroup` 返回的对象里挂了：

```js
getInfo: () => this.getFriendInfo(i),
getInfo: () => this.getGroupMemberInfo(i),
getInfo: () => this.getGroupInfo(i),
getMemberList: () => this.getGroupMemberList(i),
```

而 `SatoriAdapter` 里**一个都没有实现**（全仓 grep 只有这 4 处调用点）。
调用 `friend.getInfo()` 会抛 `TypeError: this.getFriendInfo is not a function`。

- **未修**：补实现需要 Satori 协议的接口知识，属功能开发而不是收紧。
  本次用 `@ts-expect-error` 标注（并指向本条），好处是将来谁补上了实现，
  TS 会立刻报"未使用的 @ts-expect-error"，提醒把标注拆掉。
- 归口**阶段 4（消息与适配器）**：那一阶段本来就要把这些适配器方法
  整理成统一的能力表——正是发现"某适配器缺哪几个方法"的地方。

#### D7 · `plugins/adapter/OneBotv11.js` · 绑定了不存在的方法

```js
getChannelArray: this.getGuildChannelArray.bind(this, i),
getChannelList: this.getGuildChannelList.bind(this, i),   // ← 本类没有这个方法
getChannelMap: this.getGuildChannelMap.bind(this, i),
```

本类只有 `getGuildChannelArray` 与 `getGuildChannelMap`（TS 也给了提示
"Did you mean 'getGuildChannelMap'?"）。`getChannelList()` 一旦被调用即抛 TypeError。

- **未修**：`List` 应该等价于 `Array`、`Map` 的哪一种（还是应该新写一个），
  得先确认调用方期待什么，属功能决策。
- 同样用 `@ts-expect-error` 标注，归口阶段 4。

#### D8 · `plugins/system/quit.js` · `instanceof` 守卫恒为 false（已修）

```js
if ((!gml) instanceof Map) return false
```

对**布尔值**做 `instanceof` 恒为 false，所以这个守卫**从来没生效过**——
本意显然是 `if (!(gml instanceof Map))`。已按本意修正。

#### D9 · `plugins/system/add.js` · `JSON.stringify` 的无效实参（已修）

```js
JSON.stringify(obj, "", "\t")
```

第二个参数是 replacer，而 `""` 既不是函数也不是数组，**按规范会被忽略**——
也就是说它一直是个无声的无效实参（标准写法是 `null`）。改成 `null` 行为完全一致，
同时让返回类型确定下来（TS 原来按重载推断对不上）。

### 3.4 TS8032：JSDoc「点号名」的语法约束（30 处，已清零）

报错形如：

```
lib/plugins/loader.js(445,13): error TS8032: Qualified name 'e.msg' is not allowed
  without a leading '@param {object} e'.
```

全部 30 处都是**基线导入**（`08818db`）携带的上游写法（上游同位置同样如此），
并非本次重构引入。集中在 4 个文件：`lib/plugins/plugin.js`（13）、
`lib/plugins/loader.js`（12）、`lib/renderer/Renderer.js`（3）、`lib/plugins/runtime.js`（2）。

它看上去是“纯文档问题、零风险”，**实际是本轮收紧里最容易改坏的一处**。
四种写法都实测过（每次都跑完整 `pnpm typecheck`）：

| 父级写成 | TS8032 | 自有代码报错总数 |
|---|---|---|
| `{any}` | 仍报（TS 要求的是对象类型） | 173 |
| `Record<string, any>` | 仍报 | 173 |
| `{object}` | **通过** | **198（+28）** |
| 去掉点号名，改为描述列表 | **通过** | **140** |

第三行是陷阱：`{object}` 确实满足了 TS 的语法要求，却把 `e` 从**隐式 any 收窄成 `object`**，
于是函数体里每一处 `e.xxx` 都变成 TS2339——**越修报错越多**。
（`{any}` / `Record` 两行比起始的 170 多 3 处，未深究：它们本就因 TS8032 未清除而被否决。）

最终选择把点号名降级为描述列表里的条目。

**为什么不去给它 们编一套真类型**：`e` / `data` / `cfg` 都是**适配器与插件会继续往上加字段**
的动态对象，一套封闭类型会锁死这种用法；阶段 4 的“适配器能力表 + 规范化字段”
才是它们该有的归宿。描述列表保留了全部文档价值（读者看到的还是同一句说明），
而类型上保持隐式 any——**如实描述比假精确好**。

### 3.5 `Cfg` 的 9 个动态配置组（100 处，已清零）

`lib/config/config.js` 的构造函数返回一个 Proxy，其 get 陷阱会把**任何未命中
已知成员的属性**转发给 `getAllCfg(属性名)`，即去读 `config/config/<属性名>.yaml`。
于是 `cfg.bot` / `cfg.server` / `cfg.redis` 在运行期完全合法，而类型系统无从得知——
不给它们名字，每次访问都是 TS2339（实测正好 100 处，占当时全部自有代码报错的 37%）。

修法是为这个匿名类命名、并以**交叉类型**把 9 个配置组并到导出类型上：

```js
export default /** @type {Cfg & CfgGroups} */ (new Cfg())
```

为什么用交叉而不是直接给 `Cfg` 加索引签名（`Record<string, any>`）：
索引签名会把 `masterQQ` / `master` / `uin` 这些**已显式声明**的成员一并退化成 any；
交叉类型只对“两边都有”的属性求交，已知成员的精确定义得以保留。

这 9 个名字（`bot` / `db` / `group` / `milky` / `other` / `redis` / `renderer` / `satori` / `server`）
与 `config/default_config/` 下的文件名一一对应，新增配置文件时要同步加一行。
配置项本身仍为 `Record<string, any>`：它们来自用户可手改的 YAML，逐项写类型只会腐化。

### 3.6 闸门自身的环境依赖：`#miao` 只在装了 miao-plugin 的机器上能解析（已清零）

这是**推上 GitHub 跑第一次真实 CI 才暴露**的一条：同一个提交，本地 `pnpm typecheck`
是 0 处，CI 四条矩阵腿**全部挂在 Typecheck 步**。

根因：`lib/plugins/plugin.js`、`lib/plugins/runtime.js`、`plugins/other/version.js`
里各有一处 `await import("#miao")`，而 `#miao` 映射到 `plugins/miao-plugin/`——
一个 **gitignore 的第三方插件**。装了它的机器上 TS 能解析到文件；干净克隆与 CI 里
解析不到，报 TS2307（共 5 处）。于是同一个闸门在两种环境下给出不同结论。

修法：在 `types/globals.d.ts` 里补一条环境声明，只导出本仓自有代码用到的那三个符号：

```ts
declare module "#miao" {
  export const App: any
  export const Common: any
  export const Version: any
}
```

声明为 `any` 是如实的：这批符号来自第三方插件，本仓闸门本来就不检查它
（`jsconfig.json` 把 `plugins/miao-plugin` 排除在外）。声明之后「模块存在」与
装没装插件无关，两处都是 0 处。注意 `package.json` 里 `#miao` / `#miao.models`
的映射是 L0 冻结面，本次只补类型，不动运行期。

复现与验证方式（也可当作以后改闸门的模板）：

```powershell
# 建一个不含 miao-plugin 的克隆，在里面对比四个闸门
$dst = "$env:TEMP\yz-gate-check"
git clone E:\ProjectCollection\2026_9\Work\Yunzai $dst
pnpm -C $dst i
pnpm -C $dst lint; pnpm -C $dst lint:eslint; pnpm -C $dst typecheck; pnpm -C $dst test
```

**教训**：此前那个「干净克隆可一次通过」的验收项，我只在里面跑了 `test`、
没跑 `typecheck`，于是漏过了这一条。环境无关性必须对**全部**闸门成立，
而不是对最熟悉的那一个。同类风险的排查方向：任何读取被 gitignore 路径的代码
（`plugins/miao-plugin/**`、`config/**`、`data/**`）在 CI 上都会走另一条分支。

**已在 CI 上复验**：修完推上 `286d823`，四条矩阵腿（ubuntu / windows × node 22 / 24）
的 `Typecheck` 步全部转绿，整次运行的 conclusion 为 success；四条腿的
`Format check` / `ESLint` / `Typecheck` / `Test` 逐步均为 success，
另有 `coverage` job 与 `smoke` workflow 也均为 success。

---

## 4. 收紧计划（阶段 3）

按"投入产出"排序，每步都要把对应数字降下来并在同一 PR 更新本文件：

1. ✅ 清理 §2.3 的死代码（无行为影响，可一次性完成）。
2. ⏳ 修复 D1 / D2 / D3，各自配单测（D1 必须覆盖 reject 场景）。
   **三条均已修复并各配单测**：D1 → `tests/unit/util/debounce.test.js`；
   D2 删除自赋值（无需测试，无行为）；D3 → `tests/unit/bot-proxy.test.js`（已红绿验证）。
3. ⬜ 引入 `typescript-eslint` 并开启类型感知规则（`no-floating-promises`），这需要先降低类型噪声。
4. ✅ 收敛 §3.2 的四类类型噪声，按目录推进：`lib/pipeline/` → `lib/plugins/` → `lib/message/` → `lib/config/` → `lib/bot.js`。
   **270 → 0（2026-09-24）**：按根因逐批推进，而不是按目录死磕。
   最大的三根杆杆：`Cfg` 补类型（100 处）、TS8032（30 处）、`lib/bot.js` 的
   `UinArray`（22 处）；剩下的都是长尾。详细过程见 §3.4 / §3.5 与各次提交信息。
5. ✅ 数字归零后，把 CI 中 `lint:eslint` 与 `typecheck` 的 `continue-on-error` 去掉。
   **两者均已完成**。
6. ✅ 处理 §2.2 的 P1/P2/P3（加块作用域、补 `break`、setter 改块体）。
   关于"同步更新 `99-compat-and-migration.md` 中的隐式契约说明"：**无需更新**——
   P1 原本依赖"`process.exit` 覆盖后仍不得返回"这条跨文件隐式契约，
   补上 `break` 之后该契约不再是正确性的必要条件（将来即便 exit 变成可返回的实现，
   控制流也不会穿透），因此没有需要写进契约文档的约束。

---

## 5. 已知未处理项

| 项 | 说明 |
|---|---|
| `core.autocrlf=true` 导致的 CRLF/LF 不一致 | 已用 prettier `endOfLine: "auto"` 绕过；根因治理需要新增 `.gitattributes` 并把工作区统一为 LF（需一次工作区重新检出），未在阶段 0 处理 |
| `plugins/miao-plugin` 与 `node_modules` 的 147 处类型报错 | 不受本仓控制，由 `scripts/typecheck.mjs` 过滤，不计入闸门 |
| `sequelize` / `sqlite3` 死依赖 | `pnpm install` 仍会安装（501 个包）。去留决策见 `05-persistence-config.md` 的开放问题 Q1 |
