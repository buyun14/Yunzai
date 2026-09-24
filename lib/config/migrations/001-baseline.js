import fs from "node:fs/promises"

/**
 * 基线迁移（版本 1）。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.1。
 *
 * 它本身几乎不做事——只确保 `config/config/` 存在。存在的意义是**把迁移链的起点
 * 锚定下来**：`_meta.json` 缺失时版本号读作 0，跑完这条就变成 1，
 * 从此"这个用户是升级上来的还是新装的"不再需要猜。
 *
 * 幂等：`mkdir` 带 `recursive`，目录已存在时不报错、不改动任何内容。
 */
export default {
  version: 1,
  description: "基线：确保 config/config/ 存在，并把迁移链的起点锚定到 1",

  /**
   * @param {string} configDir 用户配置目录
   * @returns {Promise<void>}
   */
  async up(configDir) {
    await fs.mkdir(configDir, { recursive: true })
  },
}
