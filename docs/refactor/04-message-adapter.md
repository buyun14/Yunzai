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
| `lib/message/component.js` | `ComponentType` 枚举 + 各类组件的构造/判定 |
| `lib/message/parse.js` | 原始 segment 数组 → `Component[]`（**含 `Unknown` 兜底，不再静默丢弃**） |
| `lib/message/render.js` | `Component[]` → 各适配器可发送的 segment 数组 |
| `lib/message/legacy.js` | `Component[]` → 现有 `e.msg` / `e.img` / `e.atBot` / … 派生字段 |
| `lib/message/capability.js` | 组件 × 适配器能力矩阵，供发送前校验 |

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
> 关键是 **旧路径 `loader.dealEvent()` 一行未动**，两边仍然各跑各的实现。
> 这不是遗漏，而是刻意的：阶段 2 建立的影子对比（旧 `deal()` vs 新流水线，逐决策点比较）
> 只有在两侧实现独立时才有意义。v1 之后影子对比**依然全绿**，这恰好成为
> "零行为变化"最强的证据——比任何逐字段断言都硬。
> 阶段 2 第 5 步删掉旧路径时，这份重复才会消失。
>
> 同时按本阶段的验收要求把 `group-unsupported-segments.json` 扩到了
> `record` / `video` / `forward` / `poke` 四段，并新增一条影子场景专门盯它。

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

- [ ] `lib/message/parse.js` 单测覆盖上表全部组件类型 + `Unknown` 兜底，输入输出用 fixture 快照
- [ ] `lib/message/legacy.js` 单测：给定 `Component[]`，派生的 `e.msg`/`e.img`/`e.atBot`/… 与 `dealEvent()` 改造前的输出一致（用阶段 0 录制样本）
- [ ] 含 `record` / `video` / `forward` 的消息样本，改造前后 `e.msg` 与插件决策序列完全一致（证明"零行为变化"）
- [ ] `umo` 单一实现，全仓无第二处拼接 `self_id` + `group_id` 的会话键
- [ ] `Bot.adapter` 索引在 `push` 后立即可用，且有单测覆盖 `path` 去重
- [ ] 能力表至少有 2 个适配器完成声明（建议 `OneBotv11` 与 `Satori`），且 `RespondStage` 能基于它拒绝不支持的发送

---

## 7. 风险

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 解析层与现有 `dealEvent` 有细微差异 | 高 | 高 | 强制分 v1/v2/v3 三步；每步用录制样本做逐字段对比 |
| `e.components` 与 `e.message` 双份数据导致不一致 | 中 | 中 | `e.components` 只读、由 `parse()` 一次生成；`e.message` 保持原样不动 |
| 适配器能力表声明与实际不符 | 中 | 中 | 能力表只用于"降级提示"，不用于"决定是否发送"——避免因声明错误导致功能静默消失 |
| `umo` 推广到全仓的改动面过大 | 中 | 中 | 先在 `RateLimit` 与 `Runtime` 两处落地并验证，其余按需推进，不做全仓一次性替换 |
| 7 个适配器各自的消息形状差异被低估 | 高 | 中 | 每个适配器至少要有一份真实消息样本进 `tests/fixtures/events/`，缺失的适配器先标记为"未验证" |
