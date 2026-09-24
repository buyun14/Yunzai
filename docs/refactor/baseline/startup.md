# 启动基线（阶段 0）

本文件记录改造开始时的真实启动行为，作为阶段 1/2/4 的性能与行为回归判据。

## 0. 环境

| 项 | 值 |
|---|---|
| Node | v24.19.0（Windows） |
| redis | 本地 `redis-server` 3.0.504，由 `lib/config/redis.js` 作为子进程拉起 |
| 渲染后端 | puppeteer（复用系统已安装的 Chrome）+ shotium |
| 插件 | **27 个**（含 `plugins/miao-plugin` 2.5.18） |
| 适配器 | **7 个**（ComWeChat / GSUIDCore / Milky / OneBotv11 / OPQBot / Satori / stdin） |
| 监听事件 | **5 个** |
| 定时任务 | **0 个** |

> ⚠️ 无真实平台账号。"online" **只表示适配器模块加载完成**，不代表任何账号已登录。
> `stdin` 适配器会上线并发送一段欢迎消息，这是本环境能达到的最接近真实的状态。

## 1. 启动时间线

两次运行均以 `----^_^----` 那行 MARK 日志为起点（0 ms）。

| 阶段 | 冷启动 | 热启动 |
|---|---:|---:|
| 起点（`TRSS-Yunzai 启动中`） | 0 ms | 0 ms |
| 渲染后端就绪（puppeteer + shotium） | +684 ms | +553 ms |
| redis 就绪 | +1271 ms | +660 ms |
| HTTP 服务器就绪（`:2536`） | +2210 ms | +1599 ms |
| 开始加载插件 | +2211 ms | +1601 ms |
| 插件加载完成（27 个） | +3343 ms | +2537 ms |
| 监听事件加载完成（5 个） | +3359 ms | +2552 ms |
| 适配器就绪 / online | +3368 ms | +2563 ms |
| **到 online 总耗时** | **3.37 s** | **2.56 s** |
| 其中：插件加载阶段 | 1.13 s | 0.94 s |

冷热差异约 0.8 s，主要来自 redis（`DB loaded from disk` 省掉约 0.6 s）。冷启动那次还要首次生成 `config/config/*.yaml`，包含额外 I/O。

**回归判据**：阶段 1/2 结束后，热启动到 online 不应超过 **3.0 s**（基线 2.56 s + 20% 余量），插件加载阶段不应超过 **1.2 s**。

## 2. 运行时产物

| 产物 | 位置 | 是否被版本控制 |
|---|---|---|
| 用户配置 | `config/config/*.yaml`（首次运行从 `config/default_config/` 复制） | 否（`.gitignore` 的 `/config/*`） |
| redis 快照 | `dump.rdb`（仓库根目录） | 否（`.gitignore` 的 `/dump.rdb`） |
| 渲染临时数据 | `temp/` | 否 |

关闭后已确认 **无残留 `redis-server` 进程**，端口正常释放。优雅关闭路径可用：

```powershell
pnpm app          # 启动
pnpm app stop     # 走 HTTP: GET http://localhost:2536/exit
```

## 3. 运行期观测

### O1 · 插件可能被重复加载（竞态）

**现象**

| 运行 | 结果 |
|---|---|
| 冷启动 | online 之后约 **+5.0 s** 出现 `[MARK][Plugin] [新增插件][system][recallReply.js]` |
| 热启动 | 等待 30 s 未出现 |

同一个 `recallReply.js` 在启动时已作为 27 个插件之一被加载，却再次被当作"新增插件"导入。

**代码路径**（`lib/plugins/loader.js`）

1. `watchDir(dirName)` 在**插件加载阶段**就执行了 `chokidar.watch(\`./plugins/${dirName}/\`)`；
2. 但 `add` 处理器挂在 `Bot.once("online", …)` 内部，即 **online 之后才注册**；
3. chokidar 默认 `ignoreInitial: false`，会为**已存在**的文件触发 `add`；
4. 若某个 `add` 落在 online 之后，`add` 分支会走 `importPlugin()` → `loadPlugin()` → `this.priority.push(...)`；
5. `loadPlugin()` 的这条路径**没有按 `key` 去重**，而 `changePlugin()`（`change` 分支）会先 `unloadPlugin(key)` —— 两条路径的语义不一致。

另外 `lodash.debounce(..., 5000)` 是 trailing 的，所以日志比 `add` 实际时间晚 5 s 出现，这也解释了"恰好 online + 5.0 s"这个时间点。

**性质：竞态。** 是否触发取决于 chokidar 初始扫描与该目录 `online` 的先后。实测窗口为
冷启动 1.16 s、热启动 0.96 s（从 `chokidar.watch` 到 online），而扫描耗时正好在同一量级附近。

**影响**（按代码推断，尚未逐项实测）

- `this.priority` 中出现同一插件的两条条目 → 同一条消息会**尝试两次**该插件；对无副作用的命令无感，对 `accept()` 或带计数的插件会产生重复执行；
- `pluginCount` / `pluginCountMap` 多计，影响 `plugins/system/status.js` 的统计数字；
- handler 不会重复注册（`Handler.add` 内部先 `del` 再 `add`），因此问题局限在 `priority` 与计数。

**归属与处理**

- 阶段 2 的 `ProcessStage` 必须假定 `priority` 可能含重复条目（或在契约层加按 `key` 去重），并在影子运行对比中覆盖这一场景；
- 阶段 2 的假适配器夹具应能**稳定复现**这一点（例如注入 `file_watch: true` 并人为延迟 online）。

## 4. 未采集项与替代方案

`00-prep.md` §2.5 的"录制真实消息事件样本"**未完成**，原因是本环境没有可用的平台账号，无法产生真实流量。

替代方案（已决定）：阶段 2 改为**手工构造覆盖各消息组件的 fixture**，而不是录制。理由：

1. 无可用账号，录制不可行；
2. 需要覆盖 `msg` / `img` / `at` / `atBot` / `file` / `reply_id` / `recall` / 黑白名单 / 各 `post_type` 等**字段组合与边界**，真实流量反而难以覆盖全；
3. 手工 fixture 可进版本控制、可稳定复现，且能明确标注每条样本要验证的决策点。

这批 fixture 与"假适配器夹具"一起列为阶段 2 的前置任务。
