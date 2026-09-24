# 阶段 4：统一消息模型与适配器抽象

> 上游：[`03-engineering.md`](./03-engineering.md) · 下游：[`05-persistence-config.md`](./05-persistence-config.md)
> 参考实现：`astrbot/core/message/components.py`、`astrbot/core/platform/platform.py`、`astrbot/core/platform/register.py`、`astrbot/core/platform/astr_message_event.py`

## 1. 目标

把"消息形状"和"适配器能力"从隐式约定变成显式抽象：

1. 收发消息走统一的 `Component` 模型，而非直接依赖 `oicq` 的 segment 结构；
2. 适配器声明自己的能力（是否支持合并转发、戳一戳、语音…），宿主与插件据此判断，而不是 `try/catch` 探测；
3. 会话标识收敛为单一 `umo`，不再在各处拼 `self_id` + `group_id`。

这一阶段的**影响面最大**，因此排在核心结构（阶段 1-2）与安全网（阶段 3）之后。

---

## 2. 现状

### 2.1 适配器的实际契约

从代码反推，适配器需要满足：

| 约定 | 依据 |
|---|---|
| 通过 `Bot.adapter.push(obj)` 注册 | 7 个适配器均如此：`ComWeChat` / `GSUIDCore` / `Milky` / `OneBotv11` / `OPQBot` / `Satori` / `stdin` |
| `obj` 需有 `id`、`name`、`path`（`path` 是去重键）、`makeLog`、`sendApi`/`sendMsg` | `plugins/adapter/OneBotv11.js:6-33` |
| `Bot.adapter` 是数组，其 `push` 被改写为**按 `path` 去重** | `lib/bot.js:44-52` |
| 通过 `Bot.em(\`${post_type}.${message_type}.${sub_type}\`, data)` 投递事件 | `plugins/adapter/*.js` 共 20+ 处 |

`Bot.em()`（`lib/bot.js:426`）的行为值得注意：

```js
em(name = "", data = {}) {
  this.prepareEvent(data)
  while (true) {
    this.emit(name, data)
    const i = name.lastIndexOf(".")
    if (i === -1) break
    name = name.slice(0, i)          // message.group.normal → message.group → message
  }
}
```

即**逐级退化的层级订阅**：适配器发 `message.group.normal`，订阅 `message` 的监听器同样会被触发。`lib/events/*.js` 与 `lib/listener/listener.js` 的 `prefix`/`event` 字段就建立在这一点上。

### 2.2 归一化逻辑分散在两处

| 位置 | 做什么 |
|---|---|
| `lib/bot.js` 的 `prepareEvent()`（约 380-420 行） | 补 `member`；补 `sender.nickname`/`sender.card`；写 `adapter_id`/`adapter_name`；给 `friend`/`group`/`member` **打补丁方法** `sendFile`/`makeForwardMsg`/`sendForwardMsg`/`getInfo`（全部用 `??=`）；兜底 `data.reply` |
| `lib/plugins/loader.js` 的 `dealEvent()` | 解析 `e.message` 数组 → `e.msg` / `e.img` / `e.atBot` / `e.at` / `e.reply_id` / `e.getReply` / `e.file`；判定 `isPrivate`/`isGroup`；拼 `logText`；判 `isMaster`；剥离 `botAlias` → `e.hasAlias`；算 `e.only_reply_at` |

**问题**：消息解析逻辑住在**插件加载器**里。任何新增消息类型都要改 `lib/plugins/loader.js` 这个与插件调度无关的文件。

### 2.3 五个具体缺口

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| 1 | 消息类型覆盖不足且静默丢弃 | `dealEvent()` 的 `switch` 只处理 `text`/`image`/`at`/`reply`/`file`/`xml`/`json`，无 `default` 分支 | 语音、视频、合并转发、戳一戳等类型到达插件时**完全不可见** |
| 2 | 能力差异用"打补丁"探测 | `lib/bot.js` 中 `i.sendFile ??= ...`、`i.makeForwardMsg ??= ...` | 适配器不支持时，补丁仍然存在，调用后行为未定义；插件无法在发送前判断 |
| 3 | 收发不对称 | 接收经 `dealEvent` 归一化；发送直接把 `segment` 数组交给适配器 | 无法做统一的发送前校验（如 AstrBot 的 `RespondStage` 那份组件非空校验表） |
| 4 | 会话标识散落 | `e.self_id` + `e.group_id`/`e.user_id` 各处拼接；`lib/plugins/plugin.js` 的 `conKey()` 再拼一遍 | 阶段 2 发现的冷却表键缺 `self_id` 就是这类问题的典型症状 |
| 5 | 适配器无声明式能力表 | 无 | 插件只能用 `adapter_id` 字符串做 `if` 判断 |

---

## 3. 设计

### 3.1 统一消息组件（`lib/message/`）

参照 `astrbot/core/message/components.py` 的组件枚举，取 Yunzai 生态实际需要的子集：

| 组件 | 现有 segment 名 | 现状是否处理 |
|---|---|---|
| `Plain` | `text` | ✅ |
| `Image` | `image` | ✅ |
| `At` / `AtAll` | `at` | ✅（合并处理，无 `AtAll` 区分） |
| `Reply` | `reply` | ✅ |
| `File` | `file` | ✅ |
| `Json` / `Xml` | `json` / `xml` | ✅（都塞进 `e.msg` 文本） |
| `Record` | `record` | ❌ 丢弃 |
| `Video` | `video` | ❌ 丢弃 |
| `Face` | `face` | ❌ 丢弃 |
| `Poke` | `poke` | ❌ 丢弃 |
| `Forward` / `Node(s)` | `forward` / `node` | ❌ 丢弃 |
| `Music` / `Share` / `Location` / `Contact` | 同名 | ❌ 丢弃 |
| `Dice` / `RPS` / `Shake` | 同名 | ❌ 丢弃 |
| `Unknown` | 其它 | ❌ 丢弃 |

新增文件：

| 文件 | 职责 |
|---|---|
| `lib/message/component.js` | `ComponentType` 枚举 + 单个 segment 的判定/构造 |
| `lib/message/parse.js` | 原始 segment 数组 → `Component[]`（**含 `Unknown` 兜底，不再静默丢弃**） |
| `lib/message/render.js` | `Component[]` → 各适配器可发送的 segment 数组；另提供“组件类型 → 能力名” |
| `lib/message/legacy.js` | `Component[]` → 现有 `e.msg` / `e.img` / `e.atBot` / … 派生字段 |
| `lib/message/umo.js` | 会话唯一键（§3.3），纯函数 |
| `lib/adapter/registry.js` | `Bot.adapter` 的只读索引（`byPath` / `byId` / `list`） |
| `lib/adapter/capabilities.js` | 组件 × 适配器能力表，及“确定不支持的组件”清单 |

> 与本节原表的两处偏差（已落地）：能力表放在 `lib/adapter/` 而不是
> `lib/message/`——它按**适配器**索引，与消息形状无关；原表的
> `lib/message/capability.js` 因此不再存在。`umo.js` 是原表没列、但 §3.3 需要的。

### 3.2 分层落地（关键：分三步，每步都零行为变化）

| 步 | 内容 | 行为变化 |
|---|---|---|
| **v1 增量** | 新增 `lib/message/`；归一化改为：先 `parse()` 得到 `Component[]` 写入 `e.components`，再由 `legacy.js` 派生出现有的 `e.msg`/`e.img`/… | 旧字段与旧行为**逐字不变**；新增 `e.components` 且 `Unknown` 组件不再丢失（仅日志可见，插件可选用） |
| **v2 上移** | 归一化从 `dealEvent()` 移到 `prepareEvent()`（`lib/bot.js`），`dealEvent` 只保留别名剥离与 `only_reply_at` 计算 | 仍无行为变化，但 `lib/plugins/loader.js` 摆脱消息解析职责 |
| **v3 发放** | 发送侧接受 `Component[]`，经 `render.js` 转成适配器 segment；`e.reply` 内部先走 `capability.js` 校验 | 新增能力，旧写法（直接传 segment）继续支持 |

> **v1 的实际落点与分册原计划不同（已落地，2026-09-24）。**
> 写这份分册时归一化还在 `PluginsLoader.dealEvent()` 里，所以原计划写的是"改 `dealEvent`"。
> 阶段 2 把这段逻辑抽成了 `NormalizeStage`（`lib/pipeline/stages/normalize.js`），
> 于是 v1 实际改的是 **`NormalizeStage.parseMessage()`**。
>
> 同时按本阶段的验收要求把 `group-unsupported-segments.json` 扩到了
> `record` / `video` / `forward` / `poke` 四段，并新增一条影子场景专门盯它。
>
> **后续（2026-09-24）**：阶段 2 第 5 步已删掉旧路径与那份重复实现，
> `NormalizeStage.parseMessage()` 成为唯一实现；两侧互证得到的行为已冻结为
> `tests/fixtures/pipeline/baseline-snapshots.json`。

> **真机浸泡（2026-09-24，SnowLuma v1.14.19 + OneBot v11）：通过。**
>
> 群聊与私聊各跑一遍 `#帮助`，都是完整路径：`开始处理 → 图片生成（miao-plugin/help/index）
> → 发送群/好友消息 → 完成`。群聊耗时 1.485s（首次出图 645ms）、私聊 605ms，
> 全程 `[ERRO]` 0 条。
>
> 这一轮实际压到的东西：`parseComponents()` 对真实 OneBot v11 载荷（`text` + 段数组）、
> `applyLegacyFields()` 派生的 `e.msg` 能被 miao-plugin 的正则命中、`umoOf()` 在真实事件上
> 不抛错、限流键迁移后照常工作（同群的第二条、以及私聊的同文都正常处理，没有被误挡）、
> 以及 `RateLimitCommitStage` 与 `RateLimitCheckStage` 用的是同一个 `umo` 键
> （两次都走完了 `[完成…]`，说明检查阶段没有因为键不一致而误拦）。
>
> **限流也补上了真机验证（同日 13:50）。** 群内同账号连发两条 `#帮助`：
> `13:50:31.983` 那条**只**有 `群消息：` 一行，既没有 `[开始处理]` 也没有出图——被冷却
> **静默**拦下（与改造前 `deal()` 的 `return` 同语义，`ctx.stop()` 不打日志）；
> `13:50:36.133` 那条则照常 `[开始处理] → 图片生成（第 5 次）→ 发送 → 完成880`。
>
> 这条为什么必须真机跑：**若检查与提交两处用了不同的键，冷却会完全失效**，
> 而单测能证明的只是"两处都调了 `umoOf()`"——键空间在真实事件上是否真的一致，
> 只有真流量能回答。
>
> 仍未压到的：1 秒同文去重（`msgThrottle`）。它与冷却同时命中时，日志里分不出是哪一条生效；
> 要单独验证得临时把 `groupCD` / `singleCD` 调成 0，为了这个改用户配置不值当。
>
> ⚠️ 仍未覆盖：非 OneBotv11 适配器的真实载荷（Milky / Satori / OPQBot 等），
> 以及 `record` / `video` / `forward` 的**真实**上行（fixture 里只有构造值）。
> 因此阶段 2 第 5 步（删旧路径）的前置条件只能算**部分**满足。

### 3.3 会话唯一键 `umo`

格式：

```
<adapter_id>:<self_id>:<scope>:<peer_id>
```

示例：

| 场景 | umo |
|---|---|
| OneBotv11 账号 12345 在群 67890 | `QQ:12345:group:67890` |
| OneBotv11 账号 12345 与用户 10001 私聊 | `QQ:12345:private:10001` |
| Satori 账号 abc 在群 g1 | `Satori:abc:group:g1` |

`adapter_id` 取自 `Bot.adapter` 项的 `id`（`OneBotv11.js` 里是 `"QQ"`），已由 `prepareEvent()` 写入 `e.adapter_id`，无需改适配器。

用途：

- `RateLimitCheckStage` 的冷却表以 `umo` 为键（顺手修掉阶段 2 的问题 C）；
- 会话级配置、`Runtime` 状态、`lib/plugins/plugin.js` 的 `conKey()` 统一改用它；
- 日志中固定输出 `umo`，便于跨账号排查。

> **落地情况（阶段 4 v2，2026-09-24）。**
>
> 已落地：`lib/message/umo.js`（唯一实现，纯函数）、`NormalizeStage` 产出 `e.umo`、
> `RateLimitCheckStage` / `RateLimitCommitStage` 的 `singleCD` 与 `msgThrottle` 键
> 改为 `umo` 前缀。
>
> 未落地，按 §7 风险表"先在两处落地、其余按需推进"处理：
>
> | 待办 | 为什么不现在做 |
> |---|---|
> | `groupCD` 的键 | 换成 `umo` 会顺带改掉"私聊共用同一个群冷却桶"这个行为，得先决定私聊该不该走群冷却（见 `baseline/startup.md` O7） |
> | `conKey()`（`lib/plugins/plugin.js`） | 它定义的是"会话状态放在哪个槽"，属于阶段 5（持久化与配置）的议题；而且它的格式里还有插件名一段，与 `umo` 不是简单替换关系 |
> | `Runtime` 的会话键 | 同上，归阶段 5 |
> | 日志里固定输出 `umo` | 会改变日志文本，而 `e.logText` 是插件可见面；要改得连同日志格式一起决定 |
>
> **阶段 5 补完（2026-09-24）：上面四项里三项已落地，一项更正。**
>
> | 项 | 结果 |
> |---|---|
> | `conKey()` | ✅ 已改为 `<插件名>.<umo>`。关键点是 `isGroup` **不等于**消息自身的群/私聊：消息在群里而插件只想为某个人开槽时用的是新增的 `scope: "user"`（`QQ:12345:user:10001`），不是 `private`——否则群里所有人会共用一个槽。键只作内存 `stateArr` 下标、不入库，所以格式变化不影响已存数据。miao-plugin 自带一份同形的 `conKey` 与自己的 `stateArr`，那份不受影响，两份表也从不互相读写 |
> | `Runtime` 的会话键 | ⚠️ **更正：不存在这样的东西。** `lib/plugins/runtime.js` 里搜不到任何会话键拼接，那些 `key` 都是 Proxy 的属性名，缓存也都是按 uid 的游戏数据缓存。这一行当初是误记 |
> | 日志输出 `umo` | ✅ 只加了一条 **debug** 日志（`[umo] …`）。刻意**不写进 `e.logText`**——那是插件可见面，改它会影响插件的字符串处理，属于行为变更；插件需要时直接读 `e.umo` |
> | `groupCD` 的键 | ⏳ 仍未动，理由见上（O7） |
>
> 键迁移顺带修掉的两处行为（都是旧键空间不一致导致的，详见
> `rate-limit-check.js` 的类注释）：
>
> 1. 同一个人在不同群发同一句话，1 秒内第二条不再被误判为重复（旧 `msgThrottle` 键里没有群号）；
> 2. 私聊的 `singleCD` 从"同一档案下所有私聊共用一套"变成"每个对端一套"
>    （旧键是 `undefined.${user_id}`）。
>
> 这两处都写成了定点单测（`tests/unit/pipeline/stages/rate-limit.test.js`）。
> ⚠️ 影子对比**证明不了**它们是对的——旧侧本来就带这两个行为，
> 对比只能确认"没有其他意外差异"。

### 3.4 适配器注册表与能力表

保持 `Bot.adapter` 为数组（L0 冻结，7 个适配器与第三方适配器都依赖 `push`），**增量**增加：

- `lib/adapter/registry.js`：`Bot.adapter` 数组的只读索引（`byId` / `byPath` / `list()`），注册表在 `push` 时同步更新；
- 能力表：适配器可通过 `capabilities` 字段声明，未声明时由宿主按 `adapter_id` 从内置默认表取值。

```js
// 声明式（可选，适配器渐进采纳）
Bot.adapter.push({
  id: "QQ",
  name: "OneBotv11",
  path: "OneBotv11",
  capabilities: {
    text: true, image: true, record: true, video: true,
    forward: true, poke: true, markdown: false,
  },
  // ...
})
```

能力表的消费方：
- `RespondStage`：发送前校验，不支持的组件降级为文本提示而非静默失败；
- 插件：`adapter.supports("forward")`；
- WebUI（阶段 6）：展示每个适配器支持的能力矩阵。

---

## 4. 兼容策略

| 对象 | 保证 |
|---|---|
| `e.msg` / `e.img` / `e.atBot` / `e.at` / `e.isPrivate` / `e.isGroup` / `e.isMaster` / `e.logText` / `e.file` / `e.reply_id` / `e.getReply` / `e.hasAlias` / `e.only_reply_at` | **L0 冻结**，v1/v2/v3 全程输出一致 |
| `e.message`（原始 segment 数组） | 保留不删 |
| `e.reply(msg, quote, data)` | 签名与语义不变；v3 仅新增"当 `msg` 是 `Component[]` 时走新路径" |
| `Bot.adapter` 为数组、`push` 按 `path` 去重 | 不变 |
| `Bot.em(name, data)` 的层级退化 | 不变 |
| `prepareEvent()` 打补丁的 `sendFile`/`makeForwardMsg`/… | 保留，v3 起同时提供能力查询 |

---

## 5. 开放问题

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | `Component[]` 存在哪里 | `e.components`（增量字段）。不要替换 `e.message`——插件生态大量直接读它 |
| Q2 | `Unknown` 组件是否写入 `e.msg` | **否**。写进 `e.msg` 会改变 `e.msg` 内容从而改变正则匹配结果，违反"零行为变化"；只存进 `e.components` 并记 debug 日志 |
| Q3 | `AtAll` 是否拆分 | **暂不拆**。现状 `at` 与 `self_id` 比较判定 `atBot`，拆分会改变判定路径；先只在 `Component` 层保真，派生字段逻辑不变 |
| Q4 | `umo` 中的 `scope` 取值 | `group` / `private`。未来若有频道（guild/channel），扩展为 `guild`/`channel` 而不改前两段 |
| Q5 | 能力表的权威来源 | 适配器显式声明优先，缺失时回落到宿主内置默认表；默认表放 `lib/adapter/capabilities.js` |

---

## 6. 验收标准

- [x] `lib/message/parse.js` 单测覆盖上表全部组件类型 + `Unknown` 兜底
      —— **偏离**：没用快照，改成逐条显式断言的表驱动用例（25 个）。理由：快照会把
      “代码当时的输出”固化成事实，而这里的类型表是要与分册逐项对齐的契约，
      新增一种组件时应该让测试红掉、而不是让快照静默更新
- [x] `lib/message/legacy.js` 单测：给定 `Component[]`，派生的 `e.msg` / `e.img` / `e.atBot` / …
      与改造前的输出一致 —— 直接用**旧路径 `PluginsLoader.dealEvent()`** 当金标准，
      对全部 14 个事件样本逐字段比较（不是写死的期望值，而是两份实现对照）
- [x] 含 `record` / `video` / `forward` 的消息样本，改造前后 `e.msg` 与插件决策序列完全一致
      —— `group-unsupported-segments.json` 已扩到这四段（加 `poke`），
      并新增一条影子场景，在真实 `deal()` 与新流水线之间对拍
- [~] `umo` 单一实现；全仓无第二处拼接 `self_id` + `group_id` 的会话键
      —— 实现与限流键已落地（§3.3 的落地表）；`conKey()`、`Runtime` 的会话键、
      日志输出 `umo` 三项**留到阶段 5**，`loader.js` 旧路径里的几处要等阶段 2 第 5 步
- [x] `Bot.adapter` 索引在 `push` 后立即可用，且有单测覆盖 `path` 去重
      —— `lib/adapter/registry.js` + `tests/unit/adapter/registry.test.js`（15 个用例），
      包含“被去重的那一个不会进索引”这条一致性断言
- [~] 能力表至少有 2 个适配器完成声明，且 `RespondStage` 能基于它拒绝不支持的发送
      —— 前件达成（`OneBotv11` 与 `Satori` 各自声明 `capabilities`）；后件**不实现**：
      本仓没有 `RespondStage`，而且 §7 的风险表明确要求能力表“不用于决定是否发送”。
      两句验收互相矛盾时按风险表（更安全的那一句）办，落成可查询 API
      （`supports()`）与降级清单（`unsupportedComponents()`），**不拦截发送**
- [x] 新增：能力表的“未知”必须与“不支持”区分开来——未登记的适配器一律返回 `undefined`，
      且有用例锁住这一点（把“未知”当“不支持”是让功能静默消失的典型写法）

---

## 7. 风险

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 解析层与现有 `dealEvent` 有细微差异 | 高 | 高 | 强制分 v1/v2/v3 三步；每步用录制样本做逐字段对比 |
| `e.components` 与 `e.message` 双份数据导致不一致 | 中 | 中 | `e.components` 只读、由 `parse()` 一次生成；`e.message` 保持原样不动 |
| 适配器能力表声明与实际不符 | 中 | 中 | 能力表只用于"降级提示"，不用于"决定是否发送"——避免因声明错误导致功能静默消失 |
| `umo` 推广到全仓的改动面过大 | 中 | 中 | 先在 `RateLimit` 与 `Runtime` 两处落地并验证，其余按需推进，不做全仓一次性替换 |
| 7 个适配器各自的消息形状差异被低估 | 高 | 中 | 每个适配器至少要有一份真实消息样本进 `tests/fixtures/events/`，缺失的适配器先标记为"未验证" |
