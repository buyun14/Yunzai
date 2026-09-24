import fs from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"
import { collectDiff, CONFIG_DIR, DEFAULTS_DIR } from "../../config/diff.js"
import { sendJSON } from "../security.js"

/**
 * `GET /api/v1/config`：只读查看配置。
 *
 * 对应 `docs/refactor/06-webui.md` §4。两种形态：
 *
 * | 请求 | 返回 |
 * |---|---|
 * | `/api/v1/config` | 文件清单 + 与出厂默认的差异**条数** |
 * | `/api/v1/config?file=bot.yaml` | 该文件在用户侧与默认侧的**值**（已脱敏） |
 *
 * # 三条刻意的约束
 *
 * 1. **只读**，而且**不导入 `lib/config/config.js`**。那个模块的构造函数会跑 `initCfg()`，
 *    会往用户配置目录里复制文件——一个叫"查看配置"的接口顺手改了用户配置是最不该有的意外。
 *    与 `lib/config/diff.js` 同一条约束（那个模块正是为此把读文件的部分独立出来的）。
 * 2. **清单只给差异条数，不给值**。值里可能有密钥，而清单会被反复轮询。
 * 3. **密钥键一律脱敏**，并在 `redacted` 里列出被遮住的路径——
 *    静默打码会让人以为配置就是 `***`，那比不打码更糟。
 */

/** 允许查看的文件名：只有本目录下的 yaml，不含任何路径分隔符 */
const FILE_NAME = /^[\w.-]+\.ya?ml$/

/**
 * 看起来像密钥的键。命中即**整个值**被遮住（`server.auth` 是个对象，遮住它才有意义）。
 *
 * 刻意不含 `key`：`https.key` 是证书**路径**不是密钥，遮它只会让排查变难。
 */
const SECRET_KEY = /pass(word)?|secret|token|auth|credential|cookie/i

/**
 * @param {object} [deps] 依赖
 * @param {string} [deps.configDir] 用户配置目录
 * @param {string} [deps.defaultsDir] 出厂默认目录
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => Promise<void>} 处理器
 */
export function createConfigHandler({ configDir = CONFIG_DIR, defaultsDir = DEFAULTS_DIR } = {}) {
  return async (req, res, next) => {
    try {
      const name = req.query.file === undefined ? "" : String(req.query.file).trim()
      if (!name) return listFiles(res, { configDir, defaultsDir })

      // 文件名先过白名单。`FILE_NAME` 不含路径分隔符，因此 `../` 与绝对路径都不可能通过；
      // 这道校验不能省——恢复/读取类接口最典型的漏洞就是让请求决定路径。
      if (!FILE_NAME.test(name) || path.basename(name) !== name)
        return sendJSON(res, 400, { code: "bad_request", message: `文件名不合法：${name}` })

      const user = await readYamlIfExists(path.join(configDir, name))
      const defaults = await readYamlIfExists(path.join(defaultsDir, name))
      if (user === undefined && defaults === undefined)
        return sendJSON(res, 404, { code: "not_found", message: `没有这个配置文件：${name}` })

      const masked = maskSecrets(user)
      sendJSON(res, 200, {
        name,
        status:
          user !== undefined ? (defaults !== undefined ? "both" : "only-user") : "only-default",
        user: masked.value,
        defaults: maskSecrets(defaults).value,
        redacted: masked.paths,
      })
    } catch (err) {
      // 显式 next(err) 而不是让 express 去接：4 参错误处理挂在应用层，
      // 这里多一步转发，语义不依赖 express 版本对 async 处理器的支持差异
      next(err)
    }
  }
}

/**
 * 文件清单：两个目录的并集，附上与默认的差异条数。
 *
 * 与 `collectDiff()` 的区别：那个函数只列出**有差异**的文件（命令行的用法是
 * "把需要改的地方告诉我"），而面板要列出全部文件，否则一份完全同步的配置会凭空消失。
 *
 * @param {import("express").Response} res 响应对象
 * @param {{ configDir: string, defaultsDir: string }} dirs 目录
 * @returns {Promise<void>} 无
 */
async function listFiles(res, { configDir, defaultsDir }) {
  const diff = await collectDiff({ configDir, defaultsDir })
  const diffOf = new Map(diff.files.map(file => [file.name, file]))
  const names = [
    ...new Set([...(await listYaml(configDir)), ...(await listYaml(defaultsDir))]),
  ].sort()

  sendJSON(res, 200, {
    dirs: { config: configDir, defaults: defaultsDir },
    summary: diff.summary,
    files: names.map(name => {
      const file = diffOf.get(name)
      return {
        name,
        status: file?.status ?? "both",
        differences: {
          missing: file?.missing.length ?? 0,
          extra: file?.extra.length ?? 0,
          changed: file?.changed.length ?? 0,
        },
      }
    }),
  })
}

/**
 * 列出目录下的 yaml 文件名（目录不存在时为空数组）。
 *
 * @param {string} dir 目录
 * @returns {Promise<string[]>} 文件名
 */
async function listYaml(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name)).map(e => e.name)
  } catch {
    return []
  }
}

/**
 * 读一份 yaml，不存在时返回 `undefined`（**不抛错**：文件缺失是正常状态）。
 *
 * 解析失败也返回 `undefined` 但会保留一个说明？不——那需要额外字段。
 * 这里选择让坏文件表现为"没有这个文件"，因为面板能做的事一样（提示去修）。
 *
 * @param {string} file 文件路径
 * @returns {Promise<unknown>} 解析结果
 */
async function readYamlIfExists(file) {
  try {
    return YAML.parse(await fs.readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * 递归遮住密钥值。
 *
 * @param {unknown} value 配置值
 * @param {string} [prefix] 路径前缀
 * @returns {{ value: unknown, paths: string[] }} 脱敏后的值与被遮住的路径
 */
export function maskSecrets(value, prefix = "") {
  const paths = []

  if (Array.isArray(value)) {
    const list = value.map((item, index) => {
      const masked = maskSecrets(item, `${prefix}[${index}]`)
      paths.push(...masked.paths)
      return masked.value
    })
    return { value: list, paths }
  }
  if (value === null || typeof value !== "object") return { value, paths }

  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key
    if (SECRET_KEY.test(key) && child !== null && child !== undefined && child !== "") {
      out[key] = "***"
      paths.push(childPath)
      continue
    }
    const masked = maskSecrets(child, childPath)
    out[key] = masked.value
    paths.push(...masked.paths)
  }
  return { value: out, paths }
}
