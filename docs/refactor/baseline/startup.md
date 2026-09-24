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

---

## 3bis. 真机接入后的观察（O2 / O3）

阶段 2 第 4 步接入真实账号（SnowLuma v1.14.19 + QQ `1609167206`）后，又发现两条**既有缺陷**。
两者都**与本阶段改造无关**（都在适配器/客户端层，`deal()` 时代同样存在），此处只登记不打补丁——
阶段 2 的目标是"行为等价"，顺手改会污染对比结论。

### O2：两条 `lifecycle` 元事件导致整条 connect 流程执行两遍

SnowLuma 在连接后发送**两条** `lifecycle` 元事件（OneBot v11 规范的 `connect` 与 `enable`），
而 `plugins/adapter/OneBotv11.js:1501` 只判 `meta_event_type === "lifecycle"`、**不区分 `sub_type`**：

```js
case "lifecycle":
  this.connect(data, ws)   // 两条都会进来
  break
```

**现象**：日志里 `OneBotv11(QQ) SnowLuma v1.14.19-node 已连接` 出现**两次**（间隔约 8 ms~42 ms），
且 `connect()` 内的 `get_login_info` / `get_friend_list` / `get_group_list` / `get_group_member_list` /
`get_csrf_token` 等 API 全部被调用两遍。

**影响**

- 连接时**双倍的 API 调用**：群多、成员多时是实打实的开销（SnowLuma 侧同样要处理两遍）；
- `Bot[data.self_id]` 被重建两次，`Bot.uin.push` 有 `includes` 守卫所以不会重复；
- `connect.<self_id>` 事件被 `Bot.em` 两次 → `lib/events/connect.js` 的欢迎语依赖
  `redis.get(key)` 去重，存在**竞态窗口**（两次相隔数十毫秒，`redis.set` 未 await 完成前第二次可能通过检查）。

**性质**：协议实现与适配器对 `sub_type` 的忽略共同导致。修法是 `connect()` 内按
`sub_type === "connect"` 过滤，或在 `connect()` 开头对 `self_id` 做幂等守卫。

### O3：群内存在镜像账号时，机器人自己的群消息会作为**新事件**回流

同一群里还有 `2061865630`「小心海2」（独立账号，非机器人自己的群名片——已用
`get_group_member_list` 核实，18 名成员，群主为 `3497817243`）。

**现象**：机器人每发出一条群消息，**0.5~0.6 秒后**必然收到一条来自 `2061865630` 的群消息，
内容与本条完全一致（含 `[CQ:at,...]` 前缀），但 `message_id` 不同：

```
[11:48:36.127][1609167206 => 1083460310] 发送群消息：[{"type":"text","data":{"text":"测试一句"}}]
[11:48:36.722][1609167206 <= 1083460310, 2061865630]  群消息：[..., 小心海2] 测试一句
```

**影响**

- 机器人的每条群回复都会**额外产生一条事件**走完整流水线（多一倍统计与插件匹配开销）；
- **回环风险**：若有插件的 `rule` 命中该文本，它的回复又会被镜像回流 →
  理论上可形成无限循环，只靠 `groupCD` / 同文去重兜底。这是接真实群时值得警惕的一类环境性风险；
- 这是**环境侧**现象（对方账号在镜像），Yunzai 侧无需修改；但它意味着
  "机器人发出的内容不构成事件"这一直觉在真实群里**不成立**。

**注意**：O3 不改变阶段 2 的结论——该事件是真实入站事件，流水线处理它与其他成员的消息无异。

---

## 4. 未采集项与替代方案

`00-prep.md` §2.5 的"录制真实消息事件样本"**未完成**，最初的原因是本环境没有可用的平台账号。

替代方案（已决定）：阶段 2 改为**手工构造覆盖各消息组件的 fixture**，而不是录制。理由：

1. 需要覆盖 `msg` / `img` / `at` / `atBot` / `file` / `reply_id` / `recall` / 黑白名单 / 各 `post_type` 等**字段组合与边界**，真实流量反而难以覆盖全；
2. 手工 fixture 可进版本控制、可稳定复现，且能明确标注每条样本要验证的决策点。

这批 fixture 与"假适配器夹具"一起列为阶段 2 的前置任务，**已完成**（`tests/fixtures/events/` 14 条）。

### 4.1 情形变化：现在有真实账号了

阶段 2 第 4 步期间接入了真实账号（SnowLuma v1.14.19 + QQ `1609167206`），
于是"无可用账号"这个理由**已失效**。但决定**不变**，只是理由换了：

- 手工 fixture 仍是主力（可版本控制、可稳定复现、可定点覆盖边界）；
- 真实账号改为承担**另一层职责**：验证 fixture **盖不到**的东西
  （真实适配器载荷、插件对 `this` 的依赖、redis 计数、`Runtime.init`、跨账号行为）。
  这一层是阶段 2 第 4a 步，正是它抓出了 3 个单测与影子运行都漏掉的缺陷。

**结论：两者互补，不互相替代。** 后续阶段应同时保留这两层，不要因为"有真机了"就退掉 fixture 单测。
