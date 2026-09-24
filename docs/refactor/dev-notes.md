# 开发笔记：工具、环境与陷阱

> 各分册写的是「要改什么、怎么验收」；**这份写的是「改的时候会被什么咬到」**。
>
> 收录判据：① 这条知识会让人少走一次弯路；② 它不属于任何一份分册的主题。
> 属于某个阶段的内容不要放这里——状态与结论只写在分册里。

## 1. 命令行

- 命令一律写成 `pnpm -C <仓库绝对路径> …` 或绝对路径。有些执行环境会**剥掉命令开头的
  `cd "..."`**——`cd` 看起来执行了，其实没有，后续命令跑在别的目录里。
- 不要把可能进入交互的命令接管道（如 `| Select-Object`）：管道会把提示藏起来，
  执行环境就无法判断"它在等输入"。要过滤输出就先写文件再读。
- **不要把长跑进程接进 `Select-Object -First N`**：凑满 N 条时 PowerShell 会掐断管道，
  `pnpm` 被杀而 node 子进程留下，而它的 stdout 已经是断的。那个实例**表面仍在监听端口、
  一部分接口正常，某些接口却永远不响应**（实测 `/api/v1/config` 挂到客户端超时，
  而 `/ready` / `/status` / `/plugins` 都正常）。这种"半死的进程"会把排查方向带偏——
  代码、依赖、路由元一查一遍，而重新干净启动就正常了。
  正确做法是重定向：`pnpm -C <仓> app *> .git/TMP_RUN.log`，之后再读文件。
- 需要多行脚本时写临时文件（如 `.git/TMP_*.mjs`）再 `node` 它。PowerShell 里 `&&` 是
  合法的链式运算符，出现在 `node -e "…"` 里会被它吃掉并报 `SyntaxError`。
- 删代码时**不要按行号删**：先按内容定位，算完区间**自下而上**删，删完立刻 `node --check`。
  终端回显在折行处会插入空格，照抄长行当锚点必然匹配不上。

## 2. 提交

- 提交信息正文里**不要用 `##` 标题**——commitlint 会把它当成 footer，报
  `footer-leading-blank` 警告。
- `lint-staged` 会在提交时对暂存文件补 `prettier --write` 与 `eslint`。所以"提交前
  `pnpm lint` 红"未必代表提交后也红（尤其对刚由脚本/测试**生成**的文件，如
  `baseline-snapshots.json`）。**但别把没查清的红当成噪音**：先看是哪个文件、谁生成的。
- CI 的步骤是**顺序执行**的：某一步失败，后面几步不会执行。所以 `CI` 挂在 `typecheck`
  时，四条腿上的 `pnpm test` 其实没跑过——不能据此认为测试通过。

## 3. 查 CI 状态

`gh` 已安装但**未登录**（不要跑 `gh auth login`：它是交互式的且涉及密钥）。
仓库是公开的，直接用免鉴权 REST：

```powershell
$h = @{ "User-Agent" = "pwsh" }
(Invoke-RestMethod "https://api.github.com/repos/buyun14/Yunzai/actions/runs?per_page=8" -Headers $h).workflow_runs |
  ForEach-Object { "{0,-8} {1,-11} {2,-9} {3}" -f $_.name, $_.status, "$($_.conclusion)", $_.head_sha.Substring(0,7) }

# 某个运行里的各 job：把 runs 换成 /actions/runs/<id>/jobs
```

## 4. 本地绿 ≠ CI 绿

**`package.json` 的 `imports` 把 `#miao` 映射到 `plugins/miao-plugin/`，而它是 gitignore 的。**
装了插件的机器能解析到文件，干净克隆与 CI 报 TS2307——同一句 `pnpm typecheck` 在两处结论不同。
修法与复现方式见 `baseline/static-analysis.md` §3.6；类型声明在 `types/globals.d.ts`。

同类风险：任何读 `plugins/miao-plugin/**`、`config/**`、`data/**` 的代码，在 CI 上都走另一条分支。

因此验收必须是「**干净克隆跑全部四个门**」，而不是只跑 `pnpm test`：

```powershell
$dst = "$env:TEMP\yz-gate-check"
git clone E:\ProjectCollection\2026_9\Work\Yunzai $dst
pnpm -C $dst i
pnpm -C $dst lint; pnpm -C $dst lint:eslint; pnpm -C $dst typecheck; pnpm -C $dst test
```

## 5. 覆盖率清单要跟着新模块走

`vitest.config.js` 的 `CORE_MODULES` 是**白名单**：新模块不加进去就等于没被统计——
覆盖率可以掉到 0 而 CI 照旧全绿。已经漏过三次（阶段 4 的 `lib/message` / `lib/adapter`、
阶段 5 的 `lib/config/`）。清单位置、判据与"哪些目录不能加"见 `03-engineering.md` §3.4.1。

## 6. `app.js` 顶层的控制流单测覆盖不到

`switch (process.argv[2])` 的各个 CLI 分支只在真跑时才执行。曾经因此漏掉一个 bug：
`process.stdout.write(text, () => process.exit())` 的回调是异步的，`break` 之后控制流继续
走到 `new Bot()`——"只读报告"顺手把整个 bot 启了起来，新实例还会因端口占用向**正在运行的
实例**发 `/exit`。

**改 `app.js` 之后必须真跑一次那条命令，并确认端口没被监听。**

## 7. 真机验证的纪律

- **不要在仓库里写真实账号、群号、token**（本仓公开）。测试环境信息留在会话记忆里。
- **归因只取本侧日志**（`[开始处理]` / `[完成N]` / `发送…`），不要用"群里出现了什么内容"
  当判据：测试群里可能挂着第二个同类账号，会把噪声看成"镜像"
  （见 `baseline/startup.md` O3）。
- 起本地测试实例前**先探测端口 2536 是否空闲**：`Bot.serverEADDRINUSE()` 会向占用者发
  `/exit`，把正在运行的实例挤掉。
- `pnpm app stop` 的**退出码是 1**，与崩溃无法区分，只能用日志判断。

## 8. 文档即状态

状态只写在文档里——不写在提交信息里，也不写在聊天记录里。改完一个阶段同步三处：

| 位置 | 同步什么 |
|---|---|
| `PLAN.md` §9 进度总表 | 勾选 + 一句话结论 |
| 对应分册 | 顶部状态标注、`> 落地情况（日期）` 块、§ 验收清单勾选 |
| `99-compat-and-migration.md` | 新增/淘汰 L1 适配与 BCR 编号；**偏离原计划的地方必须写清偏离了什么** |

勾选验收项要附**证据**（文件路径 / 命令 / 实测输出）。没有证据的勾选等于把"没人核实过"
伪装成"已验证过"，比不勾更危险。

### 8.1 在制品也要落到文档里

一次改动没做完就中断（换会话、换人、换天）时，**在制品状态写进对应分册**，
不要只留在会话记忆里：

```markdown
> **在制品（2026-09-24，未提交）**：`loader.js` 已删完、`legacy.test.js` 已改完；
> 还差 `shadow.test.js` 的旧侧用例。
> **恢复成绿的命令**：`git checkout -- lib/plugins/loader.js tests/unit/message/legacy.test.js`
```

格式随场景，但三件事必须有：**已做到哪、还差什么、怎么退回去**。
最后一条最重要——中断时的代码往往是红的，下一个人需要一条确定的复活路径。

反向也成立：**发现文档与代码不一致时，先修文档**。一份过时的进度表会让下一个人
（或下一次会话）基于错误前提做决策。

## 9. `cfg.<名字>` 是**文件**，不是嵌套键

`lib/config/config.js` 的 Proxy 把 `cfg.X` 映射到 `config/config/X.yaml` 与
`config/default_config/X.yaml`（浅合并，用户优先）。因此：

- 新增配置项要么放进**已有的** yaml（如 `server.webui.enable` → `config/config/server.yaml`），
  要么新建一个**同名**的 yaml 文件；
- 写 `cfg.webui.enable` 而只在 `server.yaml` 里放了 `webui:` 段，会去找不存在的
  `webui.yaml`，读到 `undefined` —— **静默失效，没有任何报错**（阶段 6 的 WebUI 开关
  头一版就是这么写的，真跑才看出来）；
- 浅合并的后果：用户在 `config/config/server.yaml` 里写了 `webui:` 段，
  就会**整体覆盖**默认的那个对象，不会逐键合并。新增子键时必须把这一点写进注释；
- 还有一个坑：**裸 node 脚本里读 `cfg` 会在解析失败时炸** —— `getYaml` 的 catch 里用了
  全局 `Bot.makeLog`。想单独看配置就写最小脚本 + 直接 `YAML.parse`，或者干脆真启动一次。

## 10. 类字段初始化里的 TDZ：异常被吞，整条 `.use` 链静默少挂一层

**症状**：`/dashboard/` 与 `/api/v1/*` **全部挂起**到客户端超时（不是 4xx/5xx，是连响应头都没有），
而启动日志一切正常（`WebUI 已挂载` 照打）。单测全绿——因为单测是**自己拼**中间件链的。

**根因**是在**类字段初始化表达式**里引用了正在初始化的变量：

```js
express = (() => {
  const app = Object.assign(express(), { skip_auth: [], quiet: [] })
  return app.use(WebUI.frontend.bind(WebUI, { skipAuth: app.skip_auth })) // ← app 处于 TDZ
})()
```

`app.skip_auth` 在 `const app = …` 的**同一个表达式**里求值 → `ReferenceError`；
而这个异常在字段初始化里被**吞掉**，于是 `.use(...)` 那一层从未注册。
请求走到那里没有下一层、也没有答复，只能挂到超时。

**正确写法**是把 app 先赋给一个已初始化完的局部变量，再用它：

```js
const app = Object.assign(express(), { skip_auth: [], quiet: [] })
app.use(WebUI.earlyProbe.bind(WebUI))
app.use(WebUI.frontend({ skipAuth: app.skip_auth }))
return app.use(/* 其余各层 */)
```

**排查这类问题的教训**（比坑本身值钱）：

1. **单测拼链 ≠ 真实链**。`tests/` 里的 `hostApp()` 手工按顺序挂中间件，
   所以它能绿；`lib/bot.js` 的真实字段初始化没被任何单测覆盖。
   凡是"改 `lib/bot.js` 的中间件链"的改动，**必须真启一次**再收工。
2. **`console.log` 写进被重定向的管道是块缓冲的**：进程还活着时一条都读不到，
   于是「日志文件里没有我的调试输出」会被误读成「这行代码没执行」——
   我为此绕了很久。调试长跑宿主请用**同步写 `process.stderr`**，或走 `logger`（它会 flush）。
3. **看到"中间件没被调用"先怀疑注册**，而不是分发：express 5 不再暴露
   `layer.regexp`，用 `stack[i].name` / `layer.path` 判断挂载情况更可靠；
   直接 `layer.handle(fakeReq, fakeRes, next)` 手工调用**会绕过真实分发**，结论不可信。
4. 验证宿主时**先确认端口空闲、再核对监听者 PID 就是本次启动的那个进程**：
   `Bot.serverEADDRINUSE()` 会向占用者发 `/exit`，残留实例会让"改动没生效"的假象持续很久。

## 11. `app.use("/前缀", handler)` 与挂在根上自己判断前缀

WebUI 的前端中间件（`lib/web/server.js` 的 `mountFrontend`）最终是**挂在根上**、
自己比对 `UI_PREFIX` 的，与 `earlyProbe` 同一个做法。两个原因：

- 挂在 `/dashboard` 上时 `req.url` 会被 express 剥掉前缀，看起来更省事，
  但**入口文档与 assets 的免鉴权判断必须发生在 `serverAuth` 之前**，
  而"挂在哪个路径"与"放行哪一类请求"是两件独立的事；纠缠在一起会让
  「只放行入口文档、不放行整个 `/dashboard`」这个安全边界难以表达；
- 更重要的是：**`skip_auth` 是前缀匹配**（`serverAuth` 用 `originalUrl.startsWith`），
  把 `/dashboard` 整个放进 `skip_auth` 会连适配器挂在它下面的路由一起免鉴权。
  所以入口文档走"自己认形状"、assets 走 `skip_auth` 前缀，两者分开。

