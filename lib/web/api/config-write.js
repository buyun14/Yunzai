import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { HOST_SCHEMAS, isUnmodeled } from "../../config/host-schema.js"
import { validate } from "../../plugins/schema.js"
import { sendJSON } from "../security.js"

/**
 * `PUT /api/v1/config/{name}`：写入宿主配置。
 *
 * 对应 `docs/refactor/06-webui.md` §3.5 的 v2（配置编辑）第二步。
 * **这是整个 WebUI 里第一个会改宿主状态的接口**，所以它比只读那批多一层
 * 设计，见下。
 *
 * # 四道闸门（任何一道不过都不写盘）
 *
 * | # | 闸门 | 不过时 |
 * |---|---|---|
 * | 1 | 文件名过白名单（同只读接口：`^[\w.-]+\.ya?ml$` 且 `basename` 等于原名） | 400 |
 * | 2 | 该文件**已建模**（在 `HOST_SCHEMAS` 里） | 400 |
 * | 3 | **不含敏感键**（见下） | 400 |
 * | 4 | 新值过该文件的 schema 校验 | 400 |
 *
 * 顺序是刻意的：**先拒签，再校验**。校验要读文件、要构造 Document，
 * 对一个根本不允许写的文件做这些是白费。
 *
 * # 为什么封死敏感键（而不是给个开关）
 *
 * `server.auth` 与 `server.https` 是面板**自己赖以存在**的配置：
 *
 * - 改掉 `auth` 等于"把认证配置交给一个已经通过了认证的会话去改"——
 *   轻则把所有客户端锁在外面，重则把令牌换成自己知道的值；
 * - 改 `https` 会让服务重启后起不来（证书路径写错）。
 *
 * 这个取舍与 `06-webui.md` §3.3 的"启用 WebUI 必须配 auth"是同一条思路：
 * **面板不该有能力削弱自己的门卫**。要改这两处就手动改 yaml。
 *
 * 代价是明确的：面板不能作为认证配置的唯一管理入口。对单机自建部署来说
 * 这不是问题——改 yaml 本来就是要重启才生效。
 *
 * # 原子写
 *
 * 先写 `<name>.tmp`（同目录，保证同文件系统）再 `rename` 覆盖：
 * `rename` 在 POSIX 与 Windows 上都是原子的（Windows 用 `MoveFileEx` 的
 * 替换语义）。中途断电/被杀最多留下一个 `.tmp`，而**目标文件要么是旧内容、
 * 要么是新内容**，不会半截。直接 `writeFile` 到目标就可能在写一半时留下
 * 一个语法不完整的 yaml，而那个文件会在下次启动时让配置解析失败。
 *
 * # 写前备份
 *
 * 原文件复制到 `config/backups/pre-write-<时间戳>-<文件名>`。与 `backup.js`
 * 的目录快照同域（`config/backups/` 已被 gitignore），命名带上原文件名，
 * 让人一眼知道该还原哪个。目标已存在时加后缀，**绝不覆盖**——
 * 备份被覆盖等于没有备份。
 *
 * # 保留注释
 *
 * 用 `parseDocument` + `doc.set(...)` + `toString()`，而不是 `parse` + `stringify`。
 * `config/default_config/*.yaml` 里满是解释性注释，`stringify` 会把它们全丢掉
 * ——用户看半天才改对一行，然后把注释弄没，那是很糟的体验。
 * （同 `migrations/002-master-qq-array.js` 的做法。）
 *
 * # 写入后不会立即生效
 *
 * 配置是启动期一次性读进内存的（`lib/config/config.js` 的 Proxy），
 * 所以写盘**不影响正在运行的进程**。响应里带 `restartRequired: true`，
 * 由界面告诉用户去重启——刻意不做热重载：那需要为每个配置键定义"能不能热改"，
 * 而绝大多数键（端口、监听地址、数据库路径）本来就热改不了。
 */

/** 允许写入的文件名：只有本目录下的 yaml，不含任何路径分隔符 */
const FILE_NAME = /^[\w.-]+\.ya?ml$/

/**
 * 封死的敏感键，按文件分组。
 *
 * 只列"改了会削弱门卫或让服务起不来"的：`server.auth` 是面板自己的鉴权，
 * `server.https` 是监听配置（证书路径写错则重启即挂）。
 */
const SENSITIVE_KEYS = {
  "server.yaml": ["auth", "https"],
}

/** 写入前必须显式确认的字段名（避免"手滑提交"改写生产配置） */
const CONFIRM_FIELD = "confirmed"

/**
 * 造写入处理器。
 *
 * @param {object} [deps] 依赖
 * @param {string} [deps.configDir] 用户配置目录
 * @param {string} [deps.backupDir] 写前备份目录
 * @param {Record<string, object>} [deps.schemas] schema 表（测试可注入）
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => Promise<void>} 处理器
 */
export function createConfigWriteHandler({
  configDir = path.join("config", "config"),
  backupDir = path.join("config", "backups"),
  schemas = HOST_SCHEMAS,
} = {}) {
  return async (req, res, next) => {
    try {
      const name = String(req.params?.name ?? "").trim()

      // 闸门 1：文件名白名单（与只读接口同一条规则，恢复类接口最典型的漏洞
      // 就是让请求决定路径）
      if (!FILE_NAME.test(name) || path.basename(name) !== name)
        return sendJSON(res, 400, { code: "bad_request", message: `文件名不合法：${name}` })

      // 闸门 2：未建模的文件不通过 API 写。
      // `group.yaml`（动态键）与 `db.yaml`（已废弃）都属于这一类：
      // 面板表达不了它们的结构，硬写只会覆盖掉用户手写的段。
      const schema = schemas[name]
      if (!schema) {
        const reason = isUnmodeled(name) ? "该配置文件未建模（结构表达不了）" : "没有这个配置文件"
        return sendJSON(res, 400, {
          code: "bad_request",
          message: `${reason}，请直接编辑 config/config/${name}`,
        })
      }

      const body = /** @type {any} */ (req.body)
      if (!body || typeof body !== "object" || Array.isArray(body))
        return sendJSON(res, 400, { code: "bad_request", message: "请求体必须是对象" })

      // 手滑保护：改写配置是不可逆的运维动作，要求显式确认
      if (body[CONFIRM_FIELD] !== true)
        return sendJSON(res, 428, {
          code: "confirm_required",
          message: `改写配置需要显式确认：请求体里带 ${CONFIRM_FIELD}: true`,
        })

      const incoming = body.config
      if (
        incoming === undefined ||
        incoming === null ||
        typeof incoming !== "object" ||
        Array.isArray(incoming)
      )
        return sendJSON(res, 400, { code: "bad_request", message: "config 必须是一个对象" })

      // 闸门 3：敏感键封死。
      // 只检查**用户提交的**键，不看磁盘上的——磁盘上本来就有 `auth:` 这一行
      // （出厂默认里就有），按磁盘判断等于所有写请求都被拒。
      const sensitive = SENSITIVE_KEYS[name] ?? []
      const touched = sensitive.filter(key => Object.hasOwn(incoming, key))
      if (touched.length)
        return sendJSON(res, 400, {
          code: "bad_request",
          message: `不允许通过面板修改 ${touched.join(" / ")}：它决定面板自身的鉴权与监听，请直接编辑 config/config/${name}`,
        })

      // 闸门 4：按该文件的 schema 校验。
      // 刻意**不填默认值**：写入是"采用用户给的值"，把没提交的键补成默认值
      // 等于替用户隐式改写他没碰过的字段。
      const errors = validate(schema, incoming)
      if (errors.length)
        return sendJSON(res, 400, {
          code: "bad_request",
          message: `配置校验失败：${errors.map(item => `${item.path}：${item.message}`).join("；")}`,
          errors,
        })

      const file = path.join(configDir, name)

      // 保留注释地合并：先 parseDocument，再把提交的键逐个 set 上去。
      // 这样用户手写的、以及出厂默认里带的注释都不会丢。
      let text = "{}"
      try {
        text = await fs.readFile(file, "utf8")
      } catch (err) {
        // 文件不存在是正常的：出厂默认里的文件会在 initCfg() 时补上，
        // 但用户也可能先删掉再让面板创建它。其余错误要冒出去。
        if (err?.code !== "ENOENT") throw err
      }

      const doc = YAML.parseDocument(text)
      if (doc.errors?.length)
        return sendJSON(res, 400, {
          code: "bad_request",
          message: `config/config/${name} 当前不是合法 YAML，请先修好再通过面板改：${doc.errors[0].message}`,
        })

      if (!YAML.isMap(doc.contents) && doc.contents !== null)
        return sendJSON(res, 400, {
          code: "bad_request",
          message: `config/config/${name} 的顶层不是映射，面板不会改写它`,
        })

      // 先把注释归属修对，再改值——顺序不能反，理由见 fixEmptyScalarComments
      fixEmptyScalarComments(doc)

      for (const [key, value] of Object.entries(incoming)) doc.set(key, value)

      // 写前备份（原文件存在时才备份）
      let backup = null
      try {
        await fs.access(file)
        backup = await backupBeforeWrite(file, backupDir)
      } catch (err) {
        if (err?.code !== "ENOENT") throw err
      }

      await writeAtomic(file, doc.toString())

      sendJSON(res, 200, {
        name,
        written: true,
        backup,
        // 配置是启动期读进内存的，写盘不影响正在跑的进程
        restartRequired: true,
      })
    } catch (err) {
      // 转发给应用层的错误处理（见 server.js 的说明：4 参处理器挂在应用层）
      next(err)
    }
  }
}

/**
 * 把注释归属修对：**空标量后面那一行注释，其实属于下一个键**。
 *
 * # 为什么需要这一步
 *
 * `yaml` 的 loader 对「后面紧跟注释的空标量」做了一次前瞻（look-ahead），
 * 把那行注释当成**该空标量的尾注释**记在 `value.comment` 上：
 *
 * ```yaml
 * # Redis 用户名
 * username:          ← value.comment = " Redis 密码"
 * # Redis 密码        ← 它其实是 password 的前导注释
 * password:
 * ```
 *
 * 只要值是 `null`，stringify 会把它渲染成"下一行的注释"，看起来一切正常。
 * **但一旦把这个空键填上值**，同一条注释就变成行尾注释：
 *
 * ```yaml
 * username: root # Redis 密码      ← 归属错了，而且是被我们的写入触发的
 * ```
 *
 * 出厂配置里空键很多（`username` / `password` / `chromium_path` / `puppeteer_ws` …），
 * 而"在面板里把空键填上值"正是这个接口最主要的用途，所以必须修。
 *
 * 修法是把它挪给下一个键作前导注释、清掉原处的尾注释，并清掉解析器留下的
 * `spaceBefore`（那是它准备另起一行渲染尾注释用的，注释搬走后会变成空行）。
 *
 * ⚠️ **必须在 `doc.set()` 之前调用**：改完值之后就分不清哪条注释是搬来的了。
 *
 * @param {import("yaml").Document} doc 文档
 * @returns {number} 挪动的注释条数（测试用）
 */
function fixEmptyScalarComments(doc) {
  if (!YAML.isMap(doc.contents)) return 0
  // `YAML.isMap` 对 TS 不构成收窄（contents 的静态类型是 unknown），
  // 这里按 yaml 的实际结构标注一下：items 是 { key, value } 的数组
  const pairs = /** @type {Array<{ key: any, value: any }>} */ (doc.contents.items)
  let moved = 0

  for (let i = 0; i < pairs.length - 1; i++) {
    const value = pairs[i].value
    const nextKey = pairs[i + 1]?.key
    if (!value || !nextKey) continue
    // 只处理"空标量"这一种：有值的键，其尾注释是用户真的写在行尾的
    if (value.value !== null && value.value !== undefined) continue
    if (typeof value.comment !== "string") continue

    nextKey.commentBefore = nextKey.commentBefore
      ? `${value.comment}\n${nextKey.commentBefore}`
      : value.comment
    value.comment = undefined
    nextKey.spaceBefore = false
    moved++
  }

  return moved
}

/**
 * 原子写：先写同目录的临时文件再 rename 覆盖。
 *
 * 临时文件名带上 pid 与随机段，避免两个并发写撞同一个临时文件。
 *
 * 导出是给面板的其他写盘路径复用的（插件启停也走同一套语义）——
 * "同一种写盘方式"不该有两份实现。
 *
 * @param {string} file 目标文件
 * @param {string} text 内容
 * @returns {Promise<void>} 无
 */
export async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await fs.writeFile(tmp, text, "utf8")
    await fs.rename(tmp, file)
  } catch (err) {
    // 失败时清掉临时文件，别在 config/ 里留垃圾
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * 把原文件复制到备份目录，返回备份路径。
 *
 * `config/backups/` 已被 `.gitignore` 覆盖（与迁移前备份同域）。
 * 目标已存在时依次尝试 `.1` `.2` …，**绝不覆盖**——备份被覆盖等于没有备份。
 *
 * ⚠️ 这里的 `break` 不能写成 `continue`：时间戳只精确到毫秒，
 * 同一毫秒内的两次写入会算出同一个基名。写成 `continue` 时循环会一路
 * 走到上限而**从不更新 `target`**，于是回退到那个已存在的路径，
 * 把上一份备份覆盖掉——而这个测试是唯一能发现它的地方（见 api.test.js 的
 * "不覆盖已有备份"）。
 *
 * 导出理由同 `writeAtomic`。
 *
 * @param {string} file 原文件
 * @param {string} backupDir 备份目录
 * @returns {Promise<string>} 备份文件路径
 */
export async function backupBeforeWrite(file, backupDir) {
  await fs.mkdir(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const base = `pre-write-${stamp}-${path.basename(file)}`

  let target = path.join(backupDir, base)
  for (let n = 1; n < 100; n++) {
    try {
      await fs.access(target)
    } catch {
      break // 这个路径是空的，就用它
    }
    target = path.join(backupDir, `${base}.${n}`)
  }

  await fs.copyFile(file, target)
  return target
}
