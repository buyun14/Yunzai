# 阶段 2：消息流水线

> 上游：[`01-plugin-contract.md`](./01-plugin-contract.md) · 下游：[`03-engineering.md`](./03-engineering.md)
> 参考实现：`astrbot/core/pipeline/{stage,stage_order,scheduler,bootstrap,context}.py`、`astrbot/core/event_bus.py`

## 1. 目标

把 `lib/plugins/loader.js` 里 `deal()` 的过程式流程，替换为**可注册、可排序、可中断的 Stage 流水线**，并引入事件总线让"平台产生事件"与"流水线消费事件"解耦。

收益：

1. 新增横切策略只需新增一个 Stage 文件，不改核心；
2. 阶段之间的顺序在一处集中声明并可自检（漏注册立即报错，而不是静默失效）；
3. `setLimit` 这类“处理完成后才执行”的逻辑有了明确的位置（见 §3.1：它必须拆成独立阶段，而不是靠行序）；
4. 多账号/多配置档案各自拥有独立的阶段实例（限流计数、冷却表不再互相污染）。

---

## 2. 现状：`deal()` 的隐式流程

`lib/plugins/loader.js` 中 `deal(e)` 的实际顺序：

| 序 | 调用 | 说明 |
|---|---|---|
| 1 | `this.count(e, "receive", e.message)` | 统计 |
| 2 | `if (!this.checkBlack(e)) return` | 用户/群黑白名单（读 `cfg.getOther()`） |
| 3 | `const groupCfg = cfg.getGroup(e.self_id, e.group_id)` | 取群配置 |
| 4 | `if (!this.checkLimit(e, groupCfg)) return` | 禁言检查 + 群冷却 + 单人冷却 + 1 秒同文去重 |
| 5 | `this.dealEvent(e, groupCfg)` | **事件归一化**：拼 `e.msg`、`e.img`、`e.atBot`、`e.isMaster`、`e.logText`，剥离 `botAlias`，计算 `e.only_reply_at` |
| 6 | `if (e.only_reply_at) this.setLimit(e, groupCfg)` | 冷却提交 |
| 7 | `this.reply(e)` | **包装** `e.reply`：注入 at/引用、异常兜底、定时撤回 |
| 8 | `await Runtime.init(e)` | 注册 runtime |
| 9 | 构建 `priority` 列表 | `checkDisable` + `filtEvent` 双重过滤 |
| 10 | context hook 循环 | `getContext()` 两段合并，命中即 `return`（返回 `"continue"` 则继续） |
| 11 | `if (!e.only_reply_at) return` | 唤醒门槛 |
| 12 | 游戏前缀归一化 | `srReg` / `zzzReg` → `e.game` + `isSr`/`isGs` getter |
| 13 | `accept()` 阶段 | 第一个返回真值的插件 `break`；返回 `"return"` 直接返回 |
| 14 | `rule` 匹配阶段 | `filtEvent` → `reg.test(e.msg)` → `filtPermission` → 执行 `fnc`；`res === false` 继续，否则 `return` |

### 2.1 暴露出的三个具体问题

**问题 A：横切逻辑与核心耦合。** 第 2、4、6 步都是策略，但写死在核心文件里，插件与第三方无法替换或扩展。

**问题 B：`setLimit` 的位置靠"人工插入"维持。** 它必须在"处理完成"之后、"回复"之前执行。当前是靠第 5/6/7 步的行序保证的——任何一次顺序调整都可能破坏语义，且没有测试能发现。

**问题 C：冷却表按 `group_id` 而非 `bot:group` 建键。**

```js
// lib/plugins/loader.js
if (config.groupCD && this.groupCD[e.group_id]) return false          // 缺 self_id
if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`])   // 缺 self_id
```

对比同文件里 `msgThrottle` 的键是包含 `self_id` 的：

```js
const msgId = `${e.self_id}:${e.user_id}:${e.raw_message}`
```

后果：同一个群里挂了两个 bot 账号时，A 账号触发群冷却会让 B 账号也被静默拦截。这在多账号场景下是真实可见的行为缺陷。

### 2.2 三处位置敏感的相邻关系（必须在实现中显式保留）

| # | 约束 | 依据 | 若违反 |
|---|---|---|---|
| a | `checkLimit`（第 4 步）必须在 `dealEvent`（第 5 步）**之前** | `checkLimit` 读 `e.isPrivate`，而该字段只在 `dealEvent` 中赋值；私聊消息在第 4 步时 `e.isPrivate === undefined`，因此**不会**走 `if (!e.message \|\| e.isPrivate) return true` 的早退分支，而是继续走到 `msgThrottle` 去重 | 把归一化提前到限流之前，私聊将跳过 1 秒同文去重，行为静默改变 |
| b | `setLimit` 必须在插件执行**之前** | 见上方「问题 B」 | 插件长时间渲染期间，群内其他消息不再被冷却拦截 |
| c | `if (!e.only_reply_at) return`（第 11 步）在 context hook（第 10 步）**之后** | 原代码行序 | 把唤醒门槛提前会导致 `getContext()` 钩子在不该运行的场景下少跑一次，插件的状态机会错乱 |

结论：**流程拆分不是顺序中立的**。每一处相邻关系都需要在代码里加注释，并在阶段 0 录制的事件样本上做逐决策点对比。

---

## 3. 目标 Stage 序列

```mermaid
flowchart LR
  A["Statistics<br/>统计"] --> B["WhitelistCheck<br/>黑白名单"]
  B --> C["ProfileResolve<br/>配置档案"] --> D["RateLimitCheck<br/>禁言/冷却/去重"]
  D --> E["Normalize<br/>事件归一化"] --> F["RateLimitCommit<br/>冷却提交"]
  F --> G["PreProcess<br/>reply 包装 + runtime"]
  G --> H["WakeupGate<br/>插件筛选 + 唤醒门槛"]
  H --> I["Process<br/>accept + rule 匹配"] --> J["Respond<br/>发送"]
```

| # | Stage | 对应 `deal()` 步骤 |
|---|---|---|
| 1 | `StatisticsStage` | 1（耗时由 EventBus 在 `execute()` 外包一层测） |
| 2 | `WhitelistCheckStage` | 2 |
| 3 | `ProfileResolveStage` | 3 |
| 4 | `RateLimitCheckStage` | 4 |
| 5 | `NormalizeStage` | 5 |
| 6 | `RateLimitCommitStage` | 6 |
| 7 | `PreProcessStage` | 7、8 |
| 8 | `WakeupGateStage` | 9、10、11 |
| 9 | `ProcessStage` | 12、13、14 |
| 10 | `RespondStage` | 7 的发送部分 | 否（终止段） |

### 3.1 为什么限流被拆成两个 Stage

直觉上「检查 + 提交」应该合并成一个洋葱 Stage（前置检查、`yield`、后置提交）。但现状不支持这样做：

- `setLimit` 的条件是 `e.only_reply_at`，而该字段由第 5 步的 `dealEvent` 计算；
- `setLimit` 必须在第 13/14 步插件执行**之前**生效——否则插件里一段耗时数秒的渲染会让群内其他消息在这段时间内不被冷却拦截。

因此 `RateLimitCheck`（第 4 步）与 `RateLimitCommit`（第 6 步）之间必须夹着 `NormalizeStage`，**不能**用洋葱模型表达。

### 3.2 没有洋葱模型（刻意）

阶段一律是顺序执行、返回 Promise 的普通函数。**不实现洋葱模型**，三条理由：

| # | 理由 |
|---|---|
| 1 | **在 Yunzai 里零消费者**。原计划只有 `StatisticsStage` 用它做耗时统计，而“整条流水线跑了多久”是**调度器**职责——`EventBus` 包住 `execute()` 就能测，不该由流水线内部承担 |
| 2 | **参考实现已废弃该设计**。AstrBot RFC [#1948](https://github.com/AstrBotDevs/AstrBot/issues/1948) 把 pipeline 重构为 chain/workflow，明确写着「此次重构将替代现有的洋葱模型，所有基于该模型的功能模块均需重写」；其更新说明是「实际落地为 chain 架构，简化了原有执行模型」——有序链正是本设计当前的形式 |
| 3 | **该机制自带坑**。参考实现的洋葱分支在 `async for` 结束后，外层 `for` 会继续到 `i + 1`，导致洋葱阶段下游的所有阶段被**执行第二遍**（其 `content_safety_check/stage.py` 在内容拦截路径上就会触发）。对 Yunzai 而言这等于“同一条消息里插件被执行两次” |

关于第 2 条需要说清楚：**“采纳 #1948 的设计”与“实现洋葱模型”是矛盾的**。
该 RFC 的落地形态就是“有序链 + 节点”，并不包含洋葱；完整 workflow 引擎（条件边、会话变量、会话锁）属于其 v5.x milestone，
PR #4960 至今仍为 `[WIP]`，且其自列的已知问题包括“内置命令系统需要重新设计”“WebUI 需重构”。
对 Yunzai 而言那等同于重写插件生态，直接违反 [`PLAN.md`](./PLAN.md) 的非目标与 ADR-003。

### 3.3 为将来预留的扩展点

如果将来确实需要「条件边 / 会话变量 / 会话锁」这类图状编排：

- **Stage 仍是行为的唯一单元**，插件契约（`rule` / `handler` / `accept`）不需要改动；
- **顺序决策只存在于两处**——`stage-order.js` 的声明与 `scheduler.js` 的 `processStages`，换引擎只动这两个文件；
- **会话变量已有雏形**：`ctx.stateOf(event)` 就是每事件的键值状态；
- **会话隔离已具备**：`PipelineContext` 按配置档案隔离（每档案一组阶段实例），`EventBus` 的串行队列等价于“会话锁”。

但**现在不做**：Yunzai 当前的痛点是“横切策略硬编码在 `deal()` 里”与“插件靠 priority 魔数调度”，固定有序链已经解决；引入图状引擎属于提前抽象。

### 3.4 未纳入的阶段

AstrBot 有 `ResultDecorateStage`（统一加回复前缀、`t2i`、TTS）。Yunzai 现状没有等价需求（此类装饰分散在各插件里），因此**不新增空实现**。若后续需要统一装饰，它在 `ProcessStage` 与 `RespondStage` 之间即可插入，不改动其他 Stage。

---

## 4. 实现清单

新增文件：

| 文件 | 职责 | 参考 |
|---|---|---|
| `lib/pipeline/stage.js` | `Stage` 基类、`registerStage()`、`registeredStages` 注册表 | `pipeline/stage.py` |
| `lib/pipeline/stage-order.js` | `STAGES_ORDER` 常量 + `assertStageCoverage()` | `pipeline/stage_order.py` |
| `lib/pipeline/scheduler.js` | 按序实例化、顺序执行、停止传播 | `pipeline/scheduler.py`（**仅参考顺序声明，不采纳其洋葱机制**，见 §3.2） |
| `lib/pipeline/context.js` | `PipelineContext`（配置档案、插件注册表、存储、日志） | `pipeline/context.py` |
| `lib/pipeline/bootstrap.js` | 显式 `import` 内置 stage 并校验覆盖完整 | `pipeline/bootstrap.py` |
| `lib/pipeline/stages/*.js` | 上表 8 个 Stage 实现 | `pipeline/*/stage.py` |
| `lib/event-bus.js` | 事件队列 + 按会话解析配置档案 + 分派调度器 | `core/event_bus.py` |

改动文件：

| 文件 | 改动 |
|---|---|
| `lib/plugins/loader.js` | `deal()` 改为"入队 + 由 EventBus 分派"；**保留** `deal()` 作为兼容入口（旧代码/插件直接调用它时仍走旧路径或转发到总线） |
| `lib/events/*.js` | 由直接调用 `plugins.deal(e)` 改为 `eventBus.commit(e)` |
| `lib/bot.js` | 初始化时创建 `EventBus`，并在 `exit()` 时优雅关停 |

---

## 5. 调度器实现

### 5.1 只有一种阶段：顺序执行的 Promise

```js
// lib/pipeline/scheduler.js
export async function processStages(ctx, event, from = 0) {
  for (let i = from; i < ctx.stages.length; i++) {
    const stage = ctx.stages[i]
    const produced = stage.process(event)

    // 误用已废弃的洋葱写法时直接抛错，而不是静默什么都不做
    if (isAsyncGenerator(produced))
      throw new Error(`${stage.constructor.name}.process() 返回了异步生成器…`)

    await produced
    if (ctx.isStopped(event)) break
  }
}
```

**为什么保留那个判别**：`await` 一个异步生成器**不会**执行它的函数体，只会拿到生成器对象。
如果没有这个检查，一个照抄旧文档写成 `async *process()` 的阶段会表现为“什么都没做”，排查成本极高。
把它变成显式错误只需要三行，且已有单测覆盖。

**易错点**：阶段实例必须**有状态地复用**（`initialize()` 只在启动时调一次），
否则限流计数、缓存等状态会每消息丢失。

### 5.2 中断传播

`ctx.isStopped(event)` 统一判断是否停止。语义对应现状的 `return`：

| 现状 | 目标 |
|---|---|
| `if (!this.checkLimit(e, groupCfg)) return` | `RateLimitCheckStage` 内 `ctx.stop(event)` |
| `if (!this.checkBlack(e)) return` | `WhitelistCheckStage` 内 `ctx.stop(event)` |
| 插件 `reject()` 回调 | `ProcessStage` 内转换为 `ctx.stop(event)` + 记录 `[Handler][Reject]` 日志 |
| 插件命中并返回 | `ctx.stop(event)`（不再继续尝试低优先级插件），保持与现状"命中即停"一致 |

---

## 6. 事件总线与配置档案

现状：`lib/events/*.js` 直接 `this.plugins.deal(e)`，所有账号共用同一份 `groupCD` / `singleCD` / `msgThrottle`。

目标：

```mermaid
flowchart LR
  P["适配器 / 事件监听"] -->|commit| Q["EventBus 队列"]
  Q --> R{"按 umo 解析<br/>配置档案"}
  R --> S1["档案 A 的 Scheduler<br/>独立 stage 实例"]
  R --> S2["档案 B 的 Scheduler<br/>独立 stage 实例"]
```

- **配置档案（profile）**：沿用 `cfg.getGroup(self_id, group_id)` 的键空间语义，档案 = `self_id`（Bot 账号）+ 群/私聊配置解析结果；
- 每个档案拥有一组**独立的 Stage 实例**，因此 `RateLimitStage` 的冷却表天然以档案为界，问题 C 被顺手修掉（键不再需要手写 `self_id`）；
- 队列消费用 `for await` 串行 + `Promise` 并发控制，避免慢阶段（渲染截图）阻塞整个账号。
  - **注意**：并发度不能简单设为"无限"。现状是同账号消息串行处理，改成并发会改变 `msgThrottle` 去重与插件内部的隐式时序假设。建议 v1 **保持串行**，只做结构改造，把并发留到有实测数据后再开。

---

## 7. 迁移步骤（每步独立可提交、可回滚）

1. **落地骨架，不接线**：新增 `lib/pipeline/*`，实现基类与调度器，用 fake 事件写单测；`deal()` 完全不动。
2. **等价 Stage 实现**：把现状 9 步中的策略逐条翻译成 Stage，每个 Stage 附单测（用阶段 0 录制的事件样本断言输入输出）。
3. **影子运行**：`deal()` 先跑旧逻辑，再把事件喂给新流水线并**只记录不执行**，对比两者在每个决策点的分歧，直到分歧归零。
4. **切换**：`deal()` 改为入队；旧逻辑保留一个版本周期，通过 `bot.legacy_pipeline: false` 开关可回退。
5. **清理**：删除旧路径与开关，补 Stage 的集成测试。

> 第 3 步是整个阶段最关键的保障：它把"重构不改变行为"从信念变成可观测的对比结果。
### 7.1 进度

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 手工事件 fixture + 假适配器夹具（阶段 0 遗留的前置任务） | ⬜ 未开始 |
| 1 | 骨架落地（不接线）：`stage.js` / `stage-order.js` / `context.js` / `scheduler.js` | ✅ 已完成 |
| 2 | 等价 Stage 实现（10 个） | ⬜ 未开始 |
| 3 | 影子运行对比 | ⬜ 未开始 |
| 4 | 切换（`deal()` 改为入队） | ⬜ 未开始 |
| 5 | 清理旧路径 | ⬜ 未开始 |

第 1 步落地时的实测结果：`pnpm test` 90 个用例全通；ESLint 与类型检查相对基线**无新增**。
---

## 8. 验收标准

- [x] 调度器单测：严格按 `STAGES_ORDER` 执行且每阶段恰好一次；`from` 参数；空列表；返回异步生成器时显式报错
- [x] `assertStageCoverage` 在漏注册/多注册/重复注册时抛错，均有单测覆盖
- [ ] `RateLimitCheckStage` / `RateLimitCommitStage` 单测覆盖：群冷却、单人冷却、1 秒同文去重、`only_reply_at` 为假时不提交冷却
- [ ] §2.2 的三处位置敏感约束均有注释标注，且有专门的顺序回归测试
- [ ] 阶段 0 录制的全部事件样本，在新流水线下的**决策序列**与旧 `deal()` 完全一致
- [ ] `lib/plugins/loader.js` 中 `deal()` 的过程式策略代码已被删除，文件仅剩加载与调度职责
- [ ] 多账号场景：两个 `self_id` 在同群，A 触发冷却后 B 仍正常响应（新增回归测试）
- [ ] 启动耗时与阶段 0 基线相比无显著回退

---

## 9. 风险

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 照旧文档写成 `async *process()`（已废弃的洋葱写法） | 中 | 低 | 调度器判别后**直接抛错**，不会静默失败；`stage.js` 与 `scheduler.js` 顶部都写明该设计已被否决，并有单测覆盖 |
| 阶段实例被意外重建，状态丢失 | 中 | 高 | `initialize()` 只在启动时调用；单测断言实例身份在多次事件间保持 |
| 行为出现细微差异且难以定位 | 中 | 高 | 影子运行阶段（第 7 节第 3 步）逐决策点对比 |
| 旧插件直接调用 `PluginsLoader.deal()` | 低 | 中 | 保留 `deal()` 作为兼容入口，内部转发到流水线 |
| 引入并发后时序混乱 | 中 | 高 | v1 强制串行；并发作为独立的后续实验，需单独 ADR |
| 与 `Runtime.init(e)` 的耦合 | 中 | 中 | 把 `Runtime` 注册放入 `PreProcessStage`，并为其补单测后再切换 |
