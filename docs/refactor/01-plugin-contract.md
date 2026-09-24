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

```jsonc
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": "you",
  "repo": "https://github.com/you/my-plugin",

  // 宿主版本要求（semver range）
  "yunzai": ">=3.1.0 <4.0.0",

  // 支持的适配器；缺省表示全部
  "platforms": ["onebot11", "milky"],

  // 入口文件，缺省 index.js 或目录内全部 .js
  "entry": "index.js",

  // 缺省优先级
  "priority": 5000,

  // 可选：声明能力，供宿主/WebUI 展示与校验
  "capabilities": ["message", "task", "web", "render"],

  "config": {
    "schema": "config.schema.json",
    "defaults": "config.default.json"
  },

  "i18n": { "zh-cn": "i18n/zh-cn.json" }
}
```

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

---

## 4. 实现清单

新增文件：

| 文件 | 职责 |
|---|---|
| `lib/plugins/metadata.js` | 读取、校验、缓存 `plugin.json`；对缺失者合成元数据 |
| `lib/plugins/schema.js` | 受控子集的校验 + 默认值填充（**同构**，无 Node 专有 API，可被 WebUI 复用） |
| `lib/plugins/plugin-config.js` | 插件配置读写：定位文件、加载 defaults、merge 用户配置、校验、写回 |
| `lib/plugins/version.js` | semver range 匹配（见下方开放问题） |
| `lib/plugins/legacy-adapter.js` | 旧 `plugin` 实例 → 元数据/handler 描述的转换 |

改动文件：

| 文件 | 改动 |
|---|---|
| `lib/plugins/loader.js` | `loadPlugin()` 中接入元数据校验；把 `rule` 归一化交给 `legacy-adapter.js`；保留现有容错粒度 |
| `lib/plugins/plugin.js` | 构造函数增加**可选**第二参数 `contract`（元数据 + 已解析配置）；不得改变现有参数结构 |
| `lib/plugins/handler.js` | 暂不动（阶段 2 才替换调度），仅补充 `scope` / `onDenied` 的透传 |

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

## 6. 开放问题（需在动手前定）

| # | 问题 | 备选 | 倾向 |
|---|---|---|---|
| Q1 | semver 校验依赖 | 引入 `semver` 包 / 手写 range 匹配 | **引入 `semver`**。手写 range 匹配是最容易出错的轮子，且 `semver` 是零依赖、被广泛使用的小包 |
| Q2 | 配置落盘位置 | `config/plugin/<namespace>.json` / `data/config/<namespace>/config.json` | **`config/plugin/<namespace>.json`**。与现有 `config/` 目录语义一致，且该目录已被 `.gitignore` 覆盖 |
| Q3 | schema 校验器 | 手写受控子集 / 引入 `ajv` | **手写受控子集**。理由：需要同构到浏览器、体量可控、避免 `ajv` 的编译期开销与体积 |
| Q4 | 元数据文件格式 | `plugin.json` / `yunzai.plugin.json` / 复用 `package.json` | **`plugin.json`**。插件目录内已有 `package.json` 用于依赖声明，混在一起会让"依赖"与"元数据"两种关注点耦合 |

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
