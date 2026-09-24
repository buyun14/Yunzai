import fs from "node:fs/promises"
import YAML from "yaml"

/**
 * 版本 2：把 `config/config/other.yaml` 的 `masterQQ` 统一成数组。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.1（验收要求至少两条真实迁移）。
 *
 * # 为什么这条迁移是真实的
 *
 * `lib/config/config.js` 的 `masterQQ` getter 里有这么一句：
 *
 * ```js
 * if (!Array.isArray(masterQQ)) masterQQ = [masterQQ]
 * ```
 *
 * 会存在这种兼容代码，本身就说明**标量写法在用户配置里出现过**
 * （`masterQQ: 12345`），而且它不只是历史遗留——出厂默认就是数组，
 * 只有手改过的配置才会是标量。把形态在配置层就统一掉，读侧那段兼容
 * 才有机会在将来退役；在此之前的收益是：用户在 WebUI（阶段 6）里看到的
 * 类型是一致的，而不是"有时候是数字、有时候是列表"。
 *
 * # 用 parseDocument 而不是 parse + stringify
 *
 * `YAML.parse()` 只留下数据，**注释全丢**。而 `other.yaml` 里满是
 * `# Bot账号:主人帐号` 这类注释——那才是用户真正需要的东西。
 * `parseDocument()` 保留注释与整体结构，改完再 `toString()` 出去。
 * 这是本文件最容易踩坏的地方，所以有用例专门盯着"注释还在"。
 *
 * 幂等：已经是数组、字段不存在、值为空、文件不存在——一律直接返回，不写文件。
 * 只增改已知键，**从不删除未知键**（见分册 §4 的兼容策略）。
 */
export default {
  version: 2,
  description: "other.yaml 的 masterQQ 数组化（标量写法在旧配置里很常见）",

  /**
   * @param {string} configDir 用户配置目录
   * @returns {Promise<void>}
   */
  async up(configDir) {
    const file = `${configDir}/other.yaml`

    /** @type {string} */
    let text
    try {
      text = await fs.readFile(file, "utf8")
    } catch {
      return // 没有 other.yaml 就没什么可迁移的（initCfg() 会在启动时补上）
    }

    const doc = YAML.parseDocument(text)
    if (!YAML.isMap(doc.contents)) return

    // 复数键存在时，`masterQQ` 已经被忽略（getter 优先读 masterQQs），不动它
    if (doc.has("masterQQs")) return

    const node = doc.get("masterQQ", true)
    if (node === undefined || YAML.isSeq(node)) return
    if (!YAML.isScalar(node)) return

    const value = node.value
    if (value === undefined || value === null || value === "") return

    doc.set("masterQQ", [value])
    await fs.writeFile(file, doc.toString())
  },
}
