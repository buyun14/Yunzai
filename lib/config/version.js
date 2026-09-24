import fs from "node:fs/promises"

/**
 * 配置版本号与 `config/config/_meta.json` 的读写。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.1。
 *
 * # 为什么需要一个版本号
 *
 * 现状的 `initCfg()` 只会做一件事：`config/default_config/` 里缺哪个文件就复制一份。
 * 于是当出厂配置改名、删键、换类型时，用户那份**旧配置原样留着**——不会报错，
 * 也不会提示，只会在某个插件读到 `undefined` 时炸在别处。配置有版本号、有迁移脚本，
 * 这类问题才能变成一条明确的启动日志。
 *
 * # 版本号 0 的含义
 *
 * `_meta.json` 不存在（或读不出合法 JSON）时一律返回 **0**，表示"从未迁移过"。
 * 这不是错误状态：老用户升级上来就是 0，然后由第一条迁移把它推到 1。
 * 把"文件坏了"和"文件不在"当成同一件事处理是有意的——两者的正确动作都是
 * "从 0 开始跑迁移"，而迁移脚本本身必须幂等（见 `migrate.js`）。
 */

/**
 * 当前代码期望的配置版本。
 *
 * 新增一条迁移时，把它加到 `lib/config/migrations/` 并把这个数字 +1。
 * 两者不一致时 `migrate.js` 会报错，而不是默默留下未执行的迁移。
 */
export const CURRENT_CONFIG_VERSION = 1

/** 默认的用户配置目录（`_meta.json` 就放在这里） */
export const DEFAULT_CONFIG_DIR = "config/config"

/**
 * `_meta.json` 的路径。
 *
 * @param {string} [configDir] 用户配置目录
 * @returns {string} 绝对或相对路径
 */
export function metaFile(configDir = DEFAULT_CONFIG_DIR) {
  return `${configDir}/_meta.json`
}

/**
 * 读当前配置版本。文件不存在或内容不合法时返回 0。
 *
 * @param {string} [configDir] 用户配置目录
 * @returns {Promise<number>} 版本号（≥ 0 的整数）
 */
export async function readVersion(configDir = DEFAULT_CONFIG_DIR) {
  try {
    const meta = JSON.parse(await fs.readFile(metaFile(configDir), "utf8"))
    const version = Number(meta?.config_version)
    return Number.isInteger(version) && version >= 0 ? version : 0
  } catch {
    return 0
  }
}

/**
 * 写入配置版本（覆盖 `_meta.json`）。
 *
 * `extra` 里的字段会一并写进去，供人排查用；`config_version` 与 `updated_at`
 * 由本函数负责，调用方传进来也会被覆盖。
 *
 * @param {number} version 版本号
 * @param {{ configDir?: string, extra?: Record<string, unknown> }} [options] 选项
 * @returns {Promise<Record<string, unknown>>} 实际写入的对象
 */
export async function writeVersion(version, { configDir = DEFAULT_CONFIG_DIR, extra = {} } = {}) {
  const meta = {
    ...extra,
    config_version: version,
    updated_at: new Date().toISOString(),
  }

  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(metaFile(configDir), `${JSON.stringify(meta, null, 2)}\n`)
  return meta
}
