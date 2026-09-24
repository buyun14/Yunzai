/**
 * `docs/openapi.yaml` 的手写镜像。
 *
 * # 为什么要手写而不是从契约生成
 *
 * `06-webui.md` §7.3 第 3 条把这个选择标为「第一个需要走依赖决策的地方」，结论是**手写**：
 * v1 只有 5 个 `GET`，而 `@hey-api/openapi-ts` 会引入一个 devDep + 一套生成流程。
 * 契约漂移的风险由 `tests/unit/web/openapi.test.js` 守着（它对着真实路由与真实响应体
 * 双向比对），那个才是真正防得住「契约与服务器不一致」的检查——
 * 「生成 + git diff」防的是契约与生成物，防不住契约与实现。
 *
 * # 维护约定
 *
 * **后端加了字段就必须同步这里**，否则面板上看不到——而 CI 不会因此变红
 * （`openapi.test.js` 比的是契约与服务端，不涉及前端）。
 * 这条约束的代价是明确的：字段对不上时表现为「界面少了一列」，不是报错。
 */

/** 契约里唯一的错误形状。`401` 是例外：宿主的 `serverAuth` 返回纯文本。 */
export interface ApiErrorBody {
  code: string
  message: string
}

export interface Ready {
  ready: boolean
  online?: number
  uptime: number
}

export interface StatusMemory {
  /** MB，两位小数 */
  rss: number
  heapUsed: number
  heapTotal: number
}

export interface StatusRuntime {
  node: string
  platform: string
  arch: string
  pid: number
}

export interface StatusPlugins {
  /** 调度条目数（= `priority.length`） */
  handlers: number
  /** 插件**类**的数量 */
  loaded: number
  tasks: number
}

export interface StatusAdapter {
  id: string | null
  name: string | null
}

export interface StatusAccount {
  uin: string
}

export interface Status {
  version: string
  online?: number
  uptime: number
  memory: StatusMemory
  runtime: StatusRuntime
  plugins: StatusPlugins
  adapters: StatusAdapter[]
  accounts: StatusAccount[]
}

export interface PluginRule {
  /** 正则的 `source`（不带斜杠与标志） */
  reg: string
  fnc: string | null
  permission: string | null
  /** `false` 表示该规则的日志降级为 debug；`null` 表示没声明 */
  log: boolean | null
}

export interface LoadedPlugin {
  name: string | null
  namespace: string | null
  /** 插件文件与类的标识，与日志里出现的那个一致 */
  key: string | null
  /** 声明值；`null` 表示没声明（实际顺序见数组下标） */
  priority: number | null
  description: string | null
  events: string[]
  rules: PluginRule[]
}

export interface Plugins {
  total: number
  plugins: LoadedPlugin[]
}

export interface ConfigDiffSummary {
  /** 只有清单顶层才有；`differences` 里恒为 0 */
  files: number
  /** 默认有、用户没有的键数 */
  missing: number
  /** 用户有、默认没有的键数 */
  extra: number
  /** 两边都有但值不同的键数 */
  changed: number
}

/** 文件在两侧的存在情况 */
export type ConfigFileStatus = "both" | "only-user" | "only-default"

export interface ConfigListEntry {
  name: string
  status: ConfigFileStatus
  differences: ConfigDiffSummary
}

export interface ConfigList {
  dirs: { config: string; defaults: string }
  summary: ConfigDiffSummary
  files: ConfigListEntry[]
}

/** 解析后的 YAML 值。契约里是对 object/array/string/number/boolean/null 的 oneOf。 */
export type YamlValue = unknown

export interface ConfigFile {
  name: string
  status: ConfigFileStatus
  /** 文件不存在时为 `null` */
  user: YamlValue
  defaults: YamlValue
  /** 被脱敏的路径（`a.b.c`；数组元素写成 `a[0].b`） */
  redacted: string[]
}

/** SSE 的一帧（`event: log`）。 */
export interface LogLine {
  /** 毫秒时间戳 */
  time: number
  /** log4js 等级：TRACE/DEBUG/INFO/WARN/ERROR/FATAL/MARK */
  level: string
  /** 发日志的 logger 名（`message` 是默认 logger 的名字） */
  category: string
  /** 已去掉 ANSI 颜色码 */
  message: string
}

/* ------------------------------------------------------------------ *
 *  配置编辑（v2）
 * ------------------------------------------------------------------ */

/**
 * 受控 JSON Schema 子集的字段描述。
 *
 * **只声明我们会读的键**（`additionalProperties` 是开放的）：后端可能带上
 * 更多展示提示，但表单只关心下面这些。少声明的代价是"某个提示没生效"，
 * 而不是渲染错误。
 */
export interface SchemaField {
  /** `object` / `array` / `string` / `number` / `integer` / `boolean` / `null`，或它们的数组 */
  type?: string | string[]
  title?: string
  description?: string
  default?: unknown
  /** 枚举值。配 `x-widget: select` 时渲染成下拉 */
  enum?: unknown[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  /** 展示提示：`password` / `textarea` / `select` / `raw` */
  "x-widget"?: string
  properties?: Record<string, SchemaField>
  items?: SchemaField
  required?: string[]
}

/** `GET /api/v1/config/schemas` 的响应 */
export interface ConfigSchemas {
  /** `文件名 → schema`。只有已建模的文件才会出现在这里 */
  schemas: Record<string, SchemaField>
  /** **明确不建模**的文件与原因（前端据此让用户原始编辑，而不是当成"漏了"） */
  unmodeled: Array<{ name: string; reason: string }>
}

/** `PUT /api/v1/config/{name}` 的请求体 */
export interface ConfigWriteRequest {
  /** 只提交想改的键——后端是逐个 set，没提交的键在文件里原样保留 */
  config: Record<string, unknown>
  /** 必须为 true，否则后端返回 428 */
  confirmed: true
}

/** `PUT /api/v1/config/{name}` 的响应 */
export interface ConfigWriteResult {
  name: string
  written: true
  /** 写前备份的路径；原文件不存在时为 null */
  backup: string | null
  /** 恒为 true：配置是启动期读进内存的，写盘不影响正在运行的进程 */
  restartRequired: true
}
