# 阶段 1：插件契约

> 上游：[`00-prep.md`](./00-prep.md) · 下游：[`02-pipeline.md`](./02-pipeline.md)
> 参考实现：`astrbot/core/star/star.py`、`astrbot/core/star/register/star_handler.py`、`astrbot/core/star/filter/`

## 1. 目标

在不改变旧插件写法的前提下，让插件能够**声明**自己是什么、需要什么配置、支持哪些平台、要求哪个宿主版本，并提供一套声明式的事件过滤能力。

**为什么这一步必须先于流水线**：`ProcessStage` 需要知道"这个插件的 handler 是否匹配当前事件"，如果插件仍然只提供一个裸的 `rule` 数组，过滤逻辑就只能继续写在核心循环里。

---

## 2. 现状

`lib/plugins/plugin.js` 的构造函数只接受：

```js
{ name, dsc, handler, namespace, event, priority, task, rule }
```

其中 `rule` 的字段（来自同文件的 JSDoc）：`reg / fnc / event / log / permission`。

问题：

| 缺口 | 后果 |
|---|---|
| 无 `version` / `repo` / `author` | 无法做插件列表、更新检查、来源显示 |
| 无宿主版本要求 | 宿主 API 变更后插件静默异常，报错位置离根因很远 |
| 无平台声明 | `plugins/adapter` 各适配器能力不同，插件只能在运行时 `try/catch` 探测 |
| 无配置 schema | 配置项散落在 `config/*.yaml`，无类型、无默认值、无校验、无法生成表单 |
| 无 i18n | 文案硬编码在源码里 |
| `permission` 只是字符串 | 无枚举校验，语义靠文档 |

另外 `lib/plugins/loader.js` 的容错粒度值得保留：依赖缺失走 `packageTips()` 汇总提示，单个插件抛错不阻断其他插件。

---

## 3. 设计：三层契约

| 层 | 载体 | 是否必需 |
|---|---|---|
| 元数据 | 插件根目录 `plugin.json` | 可选（缺失时自动合成） |
| 配置 | `config.schema.json` + `config.default.json` | 可选 |
| 行为 | 现有 `plugin` 基类的 `rule` / `handler`（兼容期）→ 新的声明式注册 | 必需 |

### 3.1 `plugin.json`（元数据）

**粒度是「插件目录」而不是「插件文件」**（落地时的关键决策，见 §9）。
Yunzai 的一个插件目录就是一个可分发的包（一个 git 仓库），例如 `plugins/system/`
下 9 个 `.js` 是同一个包的 9 个插件类。因此元数据放在目录级：

```
plugins/<目录名>/plugin.json
```

```jsonc
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "you",
  "repo": "https://github.com/you/my-plugin",

  // 宿主版本要求（semver range）。缺省表示不限制
  "yunzai": ">=3.1.0 <4.0.0",

  // 支持的适配器；缺省表示全部
  "platforms": ["onebot11", "milky"],

  // 可选：声明能力，供宿主/WebUI 展示与校验
  "capabilities": ["message", "task", "web", "render"],

  // 配置：true 表示用默认文件名 config.schema.json
  "config": {
    "schema": "config.schema.json",
    "defaults": "config.default.json"
  },

  "i18n": { "zh-cn": "i18n/zh-cn.json" }
}
```

> **刻意不提供** `entry` 与 `priority` 字段：这两者属于**插件类自身**（由
> `lib/plugins/plugin.js` 的构造函数参数决定）。元数据里再写一份会形成两个真相源，
> 因此不引入。

> **`version` 缺省为空串而不是 `0.0.0`**：核心自带的插件包跟随宿主版本，写死会造成与
> `package.json` 的版本漂移；第三方插件未声明时，“未知”比伪造一个 `0.0.0` 更诚实。

字段与 AstrBot `StarMetadata` 的对应关系：

| `plugin.json` | AstrBot 字段 | 说明 |
|---|---|---|
| `name` | `name` | AstrBot 的 `plugin_id` 是 `author/name`，本方案用 `namespace` 保持 Yunzai 现状 |
| `author` | `author` | — |
| `description` | `desc` / `short_desc` | — |
| `version` | `version` | — |
| `repo` | `repo` | — |
| `yunzai` | `astrbot_version` | AstrBot 用 PEP 440 specifier，这里用 semver range |
| `platforms` | `support_platforms` | — |
| `i18n` | `i18n` | — |

### 3.2 `config.schema.json`（配置）

采用 **JSON Schema 的一个受控子集**，而不是全量 JSON Schema。原因：这份 schema 需要同时被宿主（Node）和 WebUI（浏览器）使用，体量必须可控、行为必须完全一致。

受控子集：

| 关键字 | 支持 | 说明 |
|---|---|---|
| `type` | `object` `array` `string` `number` `integer` `boolean` | 必需 |
| `properties` | ✅ | 递归 |
| `items` | ✅ | 数组元素 |
| `required` | ✅ | 缺失时报错 |
| `default` | ✅ | 首次加载时写入 `config.json` |
| `enum` | ✅ | 配合 WebUI 的下拉选择 |
| `minimum` / `maximum` | ✅ | 数值范围 |
| `minLength` / `maxLength` | ✅ | 字符串长度 |
| `pattern` | ✅ | 字符串正则 |
| `title` / `description` | ✅ | WebUI 标签与提示 |
| `x-widget` | ✅ | 自定义渲染提示（如 `textarea`、`color`、`group-select`） |
| `$ref` / `allOf` / `anyOf` / `oneOf` | ❌ | 不实现，保持校验器简单 |
| `format` | ❌ | 用 `pattern` 替代 |

### 3.3 行为契约（声明式过滤）

现有 `rule` 的 `permission` 与 `event` 升级为显式过滤条件，参考 AstrBot `star/filter/`：

| AstrBot 过滤器 | Yunzai 现状 | 目标写法 |
|---|---|---|
| `permission.py`（ADMIN/MEMBER/GROUP_ADMIN/SHARED_GROUP_ADMIN + `raise_error`） | `rule.permission: master\|owner\|admin\|all` | 保留原值并补枚举校验，新增 `onDenied: "silent" \| "reply"` |
| `event_message_type.py`（GROUP/PRIVATE/OTHER/ALL） | `rule.event` | 新增 `scope: "group" \| "private" \| "all"` |
| `platform_adapter_type.py` | 无 | `platforms` 由 `plugin.json` 提供，`rule.platforms` 可覆盖 |
| `custom_filter.py`（And/Or 组合） | 插件自己写 `if` | 新增 `when: { atBot: true, hasAlias: true }` 这类键值匹配 |
| — | `rule.log` | 保留 |
| — | `rule.reg` | 保留 |

**关键约束**：`when` 只做**声明式**匹配，不引入表达式求值（不 eval、不解析自定义语法）。复杂条件继续用插件的 `accept()` / 方法内 `return false`。

> ⚠️ **落地范围调整**：`scope` / `platforms`（按平台过滤）/ `when` / `onDenied` 均已**推迟到阶段 2**。
> 理由是阶段 1 没有它们的消费者（调度器在阶段 2 才重写），提前引入就是无法验证的推测设计。
> 阶段 1 实际落地的只有两件事：`permission` 枚举的**校验告警**（不改行为），与 `plugins` 声明的**记录**（仅 debug 日志）。
>
> `platforms` 也无法在加载期强制：适配器本身就是插件（`plugins/adapter/*.js`），
> 它们与普通插件并发导入，加载期无法可靠得知“当前有哪些适配器”。

---

## 4. 实现清单（实际落地）

新增文件：

| 文件 | 职责 |
|---|---|
| `lib/plugins/schema.js` | 受控子集的 `checkSchema` / `applyDefaults` / `validate` / `normalize`。**同构**：全文件不出现任何 Node 专有 API |
| `lib/plugins/metadata.js` | 读取/校验/缓存 `plugin.json`（目录级，缓存的是 Promise 以免并发重复读盘）；对缺失者合成元数据；`checkConfigSchema()` |
| `lib/plugins/plugin-config.js` | 插件配置：读 schema 默认值 → 合并用户配置 → 填默认值并校验 → 用户文件缺失时写出 |
| `lib/plugins/version.js` | 基于 `semver` 的宿主版本校验，区分“范围不合法”与“不满足” |
| `lib/plugins/rule.js` | `rule` / `handler` 的归一化与校验告警（原计划的 `legacy-adapter.js` 职责并入此处） |

改动文件：

| 文件 | 改动 |
|---|---|
| `lib/plugins/loader.js` | `loadPlugin()` 接入元数据、版本闸门、配置加载与契约注入；规则归一化改调 `rule.js`；告警按目录/文件去重 |
| `lib/plugins/plugin.js` | 新增 `get contract()` 访问器（**取代**原计划的构造函数第二参数，原因见 §6 Q6） |
| `config/default_config/bot.yaml` | 新增 `strict_plugin_version: true`（版本闸门的逃生开关） |
| `plugins/{system,other}/plugin.json` | 内置插件元数据样板 |
| `plugins/example/plugin.json` + `config.schema.json` | 完整样板：元数据 + 配置 schema + 在插件里读 `this.contract.config` |
| `lib/plugins/handler.js` | **未改动**（阶段 2 才替换调度） |

---

## 5. 兼容策略

### 5.1 旧插件零改动

`legacy-adapter.js` 在插件无 `plugin.json` 时合成：

```js
{
  name: plugin.name,
  description: plugin.dsc,
  priority: plugin.priority,
  version: "0.0.0",
  platforms: ["*"],
  capabilities: [],
  source: "legacy",   // 供 WebUI 与日志区分
}
```

加载日志与现状保持一致（`Bot.makeLog("debug", \`加载插件 [${file.name}][${init.name}]\`, "Plugin")`），不新增告警噪音。

### 5.2 版本不匹配的处理

- 默认：**拒绝加载该插件**，输出明确文案（插件名、要求的范围、宿主实际版本、解决建议）；
- 提供 `config/bot.yaml` 级别的逃生开关 `bot.strict_plugin_version: false`（缺省 `true`），用于紧急绕过；
- 与现有容错一致：单个插件被拒不影响其他插件加载。

### 5.3 配置注入的边界

阶段 1 **只做只读注入 + 校验**，不改写运行时配置读取路径：

- 新插件可通过 `contract.config` 拿到已校验、已填默认值的配置对象；
- 旧插件继续用 `cfg.getGroup()` / 自读 yaml，行为完全不变；
- 真正的"配置统一到 schema"推迟到阶段 5。

---

## 6. 决策记录（落地时确定）

| # | 问题 | 决策 | 理由 |
|---|---|---|---|
| Q1 | semver 校验依赖 | **引入 `semver@7.8.5`**（精确版本） | 手写 range 匹配是最容易出错的轮子；它只用在校验的一次性路径上。精确锁版本因为它是“闸门”而非普通依赖 |
| Q2 | 配置落盘位置 | **`config/plugin/<目录名>.json`** | 与现有 `config/` 目录语义一致，且该目录已被 `.gitignore` 覆盖 |
| Q3 | schema 校验器 | **手写受控子集**（`lib/plugins/schema.js`） | 需要**同构到浏览器**（阶段 6 的 WebUI 要复用同一份实现做表单校验），且行为必须在两端完全一致。因此不引入 `ajv` |
| Q4 | 元数据文件格式 | **`plugin.json`** | 插件目录内已有 `package.json` 用于依赖声明，混在一起会让“依赖”与“元数据”两个关注点耦合 |
| Q5 | 元数据粒度 | **目录级**（`plugins/<目录名>/plugin.json`） | 一个目录就是一个可分发的包；且 `plugins/system/` 这类散装目录下 9 个文件共享同一份元数据，无需重复 |
| Q6 | 配置如何注入插件 | **挂在类上的 `contract` + 插件基类的 `get contract()`** | 每条消息都会用 `new i.class(e)` 新建实例（`loader.deal()`），只挂实例的话插件根本拿不到配置；构造函数参数方案也无法覆盖这条路径 |
| Q7 | `scope` / `when` / `onDenied` 何时落地 | **推迟到阶段 2** | 没有消费者（调度器在阶段 2 才重写），提前引入就是无法验证的推测设计 |

---

## 7. 验收标准

- [ ] `lib/plugins/schema.js` 有独立单测：合法/非法/缺失/默认值填充/嵌套/数组，覆盖受控子集的每个关键字
- [ ] 任选 3 个内置插件（建议 `plugins/system/status.js`、`plugins/other/install.js`、`plugins/other/update.js`）补充 `plugin.json` 后，**行为与改造前逐字一致**（对比阶段 0 记录）
- [ ] 无 `plugin.json` 的插件加载成功，日志输出与改造前无差异
- [ ] `yunzai` 范围不匹配时拒绝加载并输出可操作的报错文案
- [ ] `platforms` 声明不匹配时跳过注册但不报错（仅 debug 日志）
- [ ] 配置 schema 校验失败时，插件仍加载（使用默认值）并输出告警，不阻断
- [ ] `pnpm lint` / `pnpm typecheck` 通过

---

## 8. 风险

| 风险 | 对策 |
|---|---|
| 校验器实现有 bug 导致合法配置被拒 | 单测覆盖每个关键字；校验失败时降级为告警而非阻断 |
| 元数据校验引入额外启动耗时 | 元数据读取与 `import()` 并行；缓存到内存；阶段 0 记录了加载耗时基线用于对比 |
| 插件作者不写 `plugin.json` | 通过内置插件作为样板 + 文档；缺失时的合成路径必须与手写路径行为一致，并有测试保证 |
| 过早引入 `packages` 抽象 | Q2 决定扁平文件而非目录树，避免为将来可能的插件市场提前设计 |

---

## 9. 落地结果与偏差

### 9.1 闸门结果

| 项 | 结果 |
|---|---|
| `pnpm lint` | ✅ |
| `pnpm test` | ✅ 70 个用例（新增 65 个：`schema` / `version` / `metadata` / `rule` / `plugin-config`） |
| `pnpm lint:eslint` | 25 个问题（新增约 700 行代码，**零新增告警**，与基线持平） |
| `pnpm typecheck` | 273 处（基线 278，**下降 5 处**） |

### 9.2 行为验证（真实启动）

| 场景 | 结果 |
|---|---|
| 正常启动 | 27 插件 / 7 适配器 / 5 监听，与阶段 0 基线**逐项一致**，零告警 |
| 插件配置生成 | `config/plugin/example.json` 按 schema 默认值正确生成 |
| 版本闸门拦截 | 把示例插件的 `yunzai` 改为 `>=9.0.0` 后，共 3 个插件类被拒（`插件[24个]`），日志给出要求、当前版本与逃生开关 |
| 逃生开关 | 尚未实测（`strict_plugin_version: false`）——列入阶段 3 的回归用例 |

### 9.3 落地时发现并修掉的两个问题

1. **`path.join(dir, "")` 触发 EISDIR**：插件只声明 `config.schema` 而不声明 `defaults` 时，
   空串经 `path.join` 得到目录自身，读取时报 `EISDIR`。已修并加了回归测试
   （`tests/unit/plugins/plugin-config.test.js` 的“只声明 schema、不声明 defaults 时不产生任何问题”）。
2. **拒绝日志按插件类重复**：`plugins/example/进群退圈通知.js` 导出 2 个类，
   版本不符时同一条错误被打了 2 遍。已改为按**文件名**去重（与目录级告警去重同一思路）。

> 这两个问题都是单测发现不了的——它们只在真实启动时才暴露出来，
> 印证了「每次改动都跑一次实例」这条要求的必要性。

### 9.4 需要后续处理的事

| # | 事项 | 归属 |
|---|---|---|
| 1 | `scope` / `when` / `onDenied` / 按平台过滤 | 阶段 2 |
| 2 | `permission` 未知取值当前视为“放行”，阶段 2 改为默认拒绝 | 阶段 2（已登记在 `rule.js` 的告警文案里） |
| 3 | `plugin.json` 的 `capabilities` 与 `i18n` 目前只被读取、未被消费 | 阶段 6（WebUI 展示） |
| 4 | 核心自带插件（`system` / `other`）**未写 `version`**，其版本跟随宿主 | 保持现状，不引额外同步负担 |
