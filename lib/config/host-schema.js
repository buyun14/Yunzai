/**
 * 宿主配置的 schema 表。
 *
 * 对应文档：`docs/refactor/05-persistence-config.md` §3.2。
 *
 * # 这个模块是什么、不是什么
 *
 * 它**只是数据**：`config/default_config/*.yaml` 里每个文件的键、类型、取值范围与展示提示。
 * 校验与默认值填充复用阶段 1 的 `lib/plugins/schema.js`（同一个受控 JSON Schema 子集），
 * 所以"写进去的值合法"在宿主配置与插件配置上是**同一套判据**。
 *
 * 三条刻意的边界：
 *
 * 1. **不接管读取路径**。配置仍然由 `lib/config/config.js` 从 yaml 读，优先级不变；
 *    本模块不参与任何一次运行期取值，只是给 WebUI 渲染表单 + 写入前校验用的描述。
 * 2. **不引入 Node 专有 API**（`node:fs` / `process` 等一个都不用）。这样同一份
 *    描述将来可以直接给前端用；现在前端经 `/api/v1` 拿到的也是它的 JSON 形态。
 * 3. **覆盖不到的文件显式列进 `UNMODELED`**，而不是默默漏掉。有一份测试会检查
 *    "每个出厂 yaml 要么被建模、要么在 `UNMODELED` 里"，漏一个就红——
 *    否则新增一个配置文件、WebUI 那边悄悄不显示，没人会发现。
 *
 * # 字段怎么读
 *
 * `HOST_SCHEMAS[文件名]` 是一个顶层为 `object` 的 schema，它的 `properties`
 * 就是该 yaml 的顶层键。`title` 给 WebUI 当表单标题，`description` 当字段说明，
 * `x-widget` 提示控件形态（见下表）。**校验器不认识的关键字一律忽略**，
 * 所以 `x-widget` 只是提示，不影响合法性判定。
 *
 * | `x-widget` | 用途 |
 * |---|---|
 * | `password` | 敏感字符串，界面上先遮住 |
 * | `textarea` | 长文本（cron、多行表达式） |
 * | `select` | 配 `enum` 用的下拉 |
 * | `raw` | **不要渲染成表单**，让用户直接编辑 yaml（映射结构、带动态键的段） |
 */

/** 允许的日志等级（与 `lib/config/log.js` 的等级表一致） */
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "mark", "off"]

/**
 * 未建模的文件与原因。
 *
 * 列出它们是为了让"覆盖完整性"可断言：这份清单 + `HOST_SCHEMAS` 的键
 * 必须**恰好**等于 `config/default_config/` 下的全部 yaml 文件名。
 */
export const UNMODELED = {
  "group.yaml": "顶层是「Bot:群」动态键（外加 `default` 段），受控子集没有 additionalProperties，无法逐个建模；留给原始 yaml 编辑",
  "db.yaml": "已废弃（BCR-0001），将在两个版本后随 sequelize / sqlite3 一起移除，不建模",
}

/**
 * `bot.yaml`：行为与日志。
 *
 * 注意 `update_time` / `restart_time` 这类"间隔分钟"的语义是 **0 = 不启用**，
 * 所以下限是 0 而不是 1；把它们写成 `minimum: 1` 会让用户无法关闭定时任务。
 */
const botSchema = {
  type: "object",
  title: "行为与日志",
  properties: {
    log_level: {
      type: "string",
      enum: LOG_LEVELS,
      default: "info",
      title: "日志等级",
      description: "低于该等级的日志不输出",
      "x-widget": "select",
    },
    log_length: {
      type: "integer",
      minimum: 0,
      default: 10000,
      title: "单条日志长度",
      description: "超过该长度的日志内容会被截断",
    },
    log_object: { type: "boolean", default: true, title: "对象日志格式", description: "是否以对象形式输出日志" },
    log_align: {
      type: "string",
      default: "  TRSSYz  ",
      title: "日志 ID 对齐",
      description: "日志行里分类名两侧的填充，用来对齐输出",
    },
    plugin_load_timeout: {
      type: "integer",
      minimum: 0,
      default: 60,
      title: "插件加载超时（秒）",
    },
    strict_plugin_version: {
      type: "boolean",
      default: true,
      title: "严格校验插件声明的宿主版本",
      description: "校验 plugin.json 的 yunzai 字段，不满足则拒绝加载；仅在需要绕过某个插件的版本限制时改为 false",
    },
    file_watch: { type: "boolean", default: true, title: "监听文件变化" },

    update_time: {
      type: "integer",
      minimum: 0,
      default: 1440,
      title: "自动更新时间（分钟）",
      description: "0 表示不启用",
    },
    restart_time: {
      type: "integer",
      minimum: 0,
      default: 0,
      title: "自动重启时间（分钟）",
      description: "0 表示不启用",
    },
    update_cron: { type: ["string", "null"], default: null, title: "定时更新 cron", "x-widget": "textarea" },
    restart_cron: { type: ["string", "null"], default: null, title: "定时重启 cron", "x-widget": "textarea" },
    stop_cron: { type: ["string", "null"], default: null, title: "定时关机 cron", "x-widget": "textarea" },
    start_cron: { type: ["string", "null"], default: null, title: "定时开机 cron", "x-widget": "textarea" },

    cache_group_member: { type: "boolean", default: true, title: "缓存群成员列表" },
    online_msg_exp: {
      type: "integer",
      minimum: 0,
      default: 1440,
      title: "上线推送通知冷却（分钟）",
    },
    file_to_url_time: {
      type: "integer",
      minimum: 0,
      default: 1,
      title: "文件保存时间（分钟）",
      description: "本地图片转成对外 URL 后的有效期",
    },
    file_to_url_times: {
      type: ["integer", "null"],
      minimum: 0,
      default: null,
      title: "文件访问次数",
      description: "留空表示不限制",
    },
    msg_type_count: { type: "boolean", default: false, title: "消息类型统计" },
    "/→#": {
      type: "boolean",
      default: true,
      title: "以 / 开头转为 #",
      description: "把习惯性的 / 前缀当作 # 指令前缀处理",
    },

    chromium_path: {
      type: ["string", "null"],
      default: null,
      title: "Chromium 路径",
      description: "留空则用 puppeteer 自带的那个",
    },
    puppeteer_ws: {
      type: ["string", "null"],
      default: null,
      title: "puppeteer 接口地址",
      description: "连到已有的浏览器实例而不是自己启动",
    },
    puppeteer_timeout: {
      type: ["integer", "null"],
      minimum: 0,
      default: null,
      title: "puppeteer 截图超时（毫秒）",
      description: "留空则用默认值",
    },

    proxyAddress: {
      type: ["string", "null"],
      default: null,
      title: "米游社接口代理地址",
      description: "国际服需要",
    },
  },
}

/**
 * `server.yaml`：HTTP 服务。
 *
 * 两个键刻意标成 `raw`：
 *
 * - `auth` 是「请求头名 → 令牌」的**任意键**映射。受控子集没有 `additionalProperties`，
 *   把它建模成表单等于假装知道用户会用什么头名；后台令牌也不是"照着表单填"的东西。
 * - `https` 是"要么两个键都填、要么都不填"的一组。子集没有 `dependencies`，
 *   渲染成表单反而会让人以为只填一个也生效（实际 `bot.js` 会两者都检查）。
 */
const serverSchema = {
  type: "object",
  title: "HTTP 服务器",
  properties: {
    url: {
      type: "string",
      pattern: "^https?://",
      default: "http://localhost:2536",
      title: "对外地址",
      description: "用于生成对外可访问的链接（如 /File 的图片地址）",
    },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 2536, title: "端口" },
    address: {
      type: ["string", "null"],
      default: null,
      title: "监听地址",
      description: "留空 = Node 默认（全部网卡）。本服务同时承担 /File 的对外图片地址与适配器回调，只在确定不需要外部访问时改成 127.0.0.1",
    },
    auth: {
      type: ["object", "null"],
      default: null,
      title: "鉴权",
      description: "键名 = 请求头名，值 = 该头应携带的令牌；任一键不匹配即 401。为空则完全放行",
      "x-widget": "raw",
    },
    webui: {
      type: "object",
      title: "运维面板",
      properties: {
        enable: {
          type: "boolean",
          default: false,
          title: "启用面板",
          description: "启用前必须先配好 auth；auth 为空时会拒绝挂载并在启动日志里给出配置指引（见 docs/refactor/06-webui.md）",
        },
      },
    },
    https: {
      type: ["object", "null"],
      default: null,
      title: "HTTPS",
      description: "key 与 cert 必须同时提供，否则不会启用 HTTPS",
      "x-widget": "raw",
    },
  },
}

/**
 * `other.yaml`：好友/群邀请与名单。
 *
 * `masterQQ` / `master` 是数组：原版是单个标量，迁移 002 已把它们数组化，
 * 因此这里按数组建模（`items` 为字符串）。
 */
const otherSchema = {
  type: "object",
  title: "好友、邀请与名单",
  properties: {
    autoFriend: {
      type: "integer",
      enum: [0, 1],
      default: 1,
      title: "自动同意加好友",
      description: "1 = 同意，0 = 不处理",
      "x-widget": "select",
    },
    autoGroup: {
      type: "integer",
      enum: [0, 1],
      default: 0,
      title: "自动同意群邀请",
      description: "0 = 仅主人，1 = 所有人",
      "x-widget": "select",
    },
    autoQuit: {
      type: "integer",
      minimum: 0,
      default: 50,
      title: "自动退群人数",
      description: "被好友拉进群且群人数小于该值时自动退出；0 = 不处理",
    },
    masterQQ: {
      type: "array",
      items: { type: "string" },
      default: ["stdin"],
      title: "主人账号",
      description: "QQ 号列表；stdin 表示内置的调试适配器",
    },
    master: {
      type: "array",
      items: { type: "string" },
      default: ["stdin:stdin"],
      title: "Bot 账号 : 主人账号",
      description: "形如 114514:10001，用于多账号下指定各自的主人",
    },

    disablePrivate: {
      type: "boolean",
      default: false,
      title: "禁用私聊功能",
      description: "true = 私聊只接受 ck 与抽卡链接（主人不受限）",
    },
    disableMsg: { type: "string", default: "私聊功能已禁用，仅支持发送cookie，抽卡记录链接，记录日志文件", title: "禁用私聊时的提示" },
    disableAdopt: {
      type: "array",
      items: { type: "string" },
      default: ["stoken"],
      title: "私聊通行字符串",
    },

    // 元素允许 string 与 number：出厂默认值就是数字（`- 213938015`），
    // 而用户手写时常常加引号。运行期两边都认——`lib/plugins/loader.js` 用
    // `Number(e.user_id) || String(e.user_id)` 兜两种形态，
    // 阶段 2 的 `whitelist-check` 走 `matchId()` 同样兼容。
    // 所以 schema 只约束"是 QQ 号"，不替用户决定写成数字还是字符串。
    //
    // 刻意**不给 default**：出厂 yaml 里这些键是 null（未配置），
    // 而 `default: null` 会对用户已有值产生"webui 上看起来被改过"的错觉；
    // 未配置时运行期用 `?.length` 判断，null 与 [] 都安全。
    whiteGroup: {
      type: ["array", "null"],
      items: { type: ["string", "number"] },
      title: "白名单群",
    },
    whiteUser: {
      type: ["array", "null"],
      items: { type: ["string", "number"] },
      title: "白名单用户",
    },
    blackGroup: {
      type: ["array", "null"],
      items: { type: ["string", "number"] },
      title: "黑名单群",
    },
    blackUser: {
      type: ["array", "null"],
      items: { type: ["string", "number"] },
      title: "黑名单用户",
    },
  },
}

/** `redis.yaml`：内置 redis 的连接参数 */
const redisSchema = {
  type: "object",
  title: "Redis",
  properties: {
    path: { type: "string", default: "redis-server", title: "Redis 命令路径", description: "内置启动 redis 时用的可执行文件" },
    host: { type: "string", default: "127.0.0.1", title: "地址" },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 6379, title: "端口" },
    username: { type: ["string", "null"], default: null, title: "用户名" },
    password: { type: ["string", "null"], default: null, title: "密码", "x-widget": "password" },
    db: { type: "integer", minimum: 0, default: 0, title: "数据库编号" },
  },
}

/** `renderer.yaml`：渲染后端选择 */
const rendererSchema = {
  type: "object",
  title: "渲染后端",
  properties: {
    name: {
      type: ["string", "null"],
      default: null,
      title: "渲染后端",
      description: "留空 = 自动选择（可用的后端里挑一个）",
    },
  },
}

/** `milky.yaml`：Milky 协议适配器 */
const milkySchema = {
  type: "object",
  title: "Milky 适配器",
  properties: {
    enable: { type: "boolean", default: false, title: "启用" },
    host: { type: "string", default: "127.0.0.1", title: "服务器地址" },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 3000, title: "服务器端口" },
    prefix: { type: "string", default: "", title: "URL 前缀" },
    access_token: { type: "string", default: "", title: "鉴权 Token", "x-widget": "password" },
    connection: {
      type: "string",
      enum: ["ws", "webhook"],
      default: "ws",
      title: "事件接收方式",
      "x-widget": "select",
    },
    webhook: {
      type: "object",
      title: "WebHook（connection 为 webhook 时有效）",
      properties: { path: { type: "string", default: "/milky", title: "WebHook 路径" } },
    },
    ws: {
      type: "object",
      title: "WebSocket（connection 为 ws 时有效）",
      properties: {
        heartbeat: { type: "integer", minimum: 0, default: 30, title: "心跳间隔（秒）" },
        reconnect_interval: { type: "integer", minimum: 0, default: 10, title: "断线重连间隔（秒）" },
      },
    },
    http_timeout: { type: "integer", minimum: 0, default: 15, title: "HTTP 请求超时（秒）" },
  },
}

/** `satori.yaml`：Satori 协议适配器 */
const satoriSchema = {
  type: "object",
  title: "Satori 适配器",
  properties: {
    enable: { type: "boolean", default: false, title: "启用" },
    http_endpoint: {
      type: "string",
      pattern: "^https?://",
      default: "http://127.0.0.1:5140/satori/v1",
      title: "HTTP API 终结点",
    },
    ws_endpoint: {
      type: "string",
      pattern: "^wss?://",
      default: "ws://127.0.0.1:5140/satori/v1/events",
      title: "WebSocket 事件终结点",
    },
    token: { type: "string", default: "", title: "API 访问令牌", "x-widget": "password" },
    platform: { type: "string", default: "satori", title: "平台名称" },
    timeout: { type: "integer", minimum: 0, default: 60000, title: "超时时间（毫秒）" },
    heartbeat_interval: { type: "integer", minimum: 0, default: 10000, title: "心跳间隔（毫秒）" },
  },
}

/**
 * 文件名 → 顶层 schema。
 *
 * 键必须与 `config/default_config/<键>` 对得上；有一条测试会逐项核对。
 */
export const HOST_SCHEMAS = {
  "bot.yaml": botSchema,
  "server.yaml": serverSchema,
  "other.yaml": otherSchema,
  "redis.yaml": redisSchema,
  "renderer.yaml": rendererSchema,
  "milky.yaml": milkySchema,
  "satori.yaml": satoriSchema,
}

/**
 * 取某个配置文件的 schema。
 *
 * @param {string} name 文件名，如 `bot.yaml`
 * @returns {object|undefined} schema；未建模或未列进 `UNMODELED` 时返回 `undefined`
 */
export function schemaFor(name) {
  return Object.hasOwn(HOST_SCHEMAS, name) ? HOST_SCHEMAS[name] : undefined
}

/**
 * 该文件是否**明确不建模**（而不是漏了）。
 *
 * WebUI 据此决定"这个文件只能原始编辑"而不是"没拿到 schema，先不显示"。
 *
 * @param {string} name 文件名
 * @returns {boolean} 是否在 `UNMODELED` 名单里
 */
export function isUnmodeled(name) {
  return Object.hasOwn(UNMODELED, name)
}

/**
 * 全部的已建模文件名（有序，便于稳定输出与快照测试）。
 *
 * @returns {string[]} 文件名列表
 */
export function schemaNames() {
  return Object.keys(HOST_SCHEMAS).sort()
}
