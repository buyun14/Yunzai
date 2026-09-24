import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * L0 冻结面守卫。
 *
 * 见 docs/refactor/99-compat-and-migration.md：这些路径与全局变量是内置插件与
 * 第三方插件依赖的契约，任何重构都不得移动或删除它们。本测试在每次 CI 中兜底。
 */

const root = fileURLToPath(new URL("../../../", import.meta.url))

/** 路径一旦移动，插件侧 import 会全部失败 */
const FROZEN_PATHS = [
  "app.js",
  "lib/bot.js",
  "lib/util.js",
  "lib/config/config.js",
  "lib/plugins/loader.js",
  "lib/plugins/handler.js",
  "lib/plugins/plugin.js",
  "lib/plugins/runtime.js",
  "lib/listener/listener.js",
  "lib/listener/loader.js",
]

/** 收集 .js 文件，跳过第三方与生成目录 */
function collectJsFiles(dir, acc = [], skip = new Set()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || skip.has(entry.name))
      continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectJsFiles(full, acc, skip)
    else if (entry.name.endsWith(".js")) acc.push(full)
  }
  return acc
}

const IMPORT_FROM_RE = /\bfrom\s*["']([^"']+)["']/g
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*["']([^"']+)["']/gm

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

describe("L0 冻结面", () => {
  it("冻结路径均存在", () => {
    for (const rel of FROZEN_PATHS)
      expect(existsSync(path.join(root, rel)), `${rel} 不应被移动或删除`).toBe(true)
  })

  it("package.json 的 #miao 子路径映射存在且指向真实文件", () => {
    const imports = pkg.imports ?? {}

    // miao-plugin 是 gitignore 的第三方插件，干净克隆与 CI 中都不存在，
    // 所以这里必须分两层断言：
    //   1) 映射字符串逐字固定 —— 任何环境下都可校验，这才是真正的冻结契约；
    //   2) 目标文件存在 —— 只在插件已安装时可校验，它防的是另一类风险：
    //      vendored 插件升级后入口挪位，导致 `import("#miao")` 在运行时才炸。
    // 若把 2) 写成无条件断言，干净克隆会永久失败（本测试原先正是如此），
    // 接受标准"干净克隆上一次通过"也就无从满足。
    const EXPECTED = {
      "#miao": "./plugins/miao-plugin/components/index.js",
      "#miao.models": "./plugins/miao-plugin/models/index.js",
    }

    for (const [key, expected] of Object.entries(EXPECTED)) {
      expect(imports[key], `缺少 imports 映射 ${key}`).toBe(expected)
    }

    if (!existsSync(path.join(root, "plugins/miao-plugin"))) {
      // 显式记录"本次跳过了什么"，避免读日志时误以为文件存在性已被校验
      console.info("[frozen-surface] 未安装 miao-plugin，跳过 #miao 目标文件存在性校验")
      return
    }

    for (const [key, rel] of Object.entries(EXPECTED)) {
      expect(existsSync(path.join(root, rel)), `${key} → ${rel} 不存在`).toBe(true)
    }
  })

  it("lib/plugins/plugin.js 仍从 #miao 动态取 Common", () => {
    const src = readFileSync(path.join(root, "lib/plugins/plugin.js"), "utf8")
    expect(src).toContain('import("#miao")')
  })

  it("lib/plugins/loader.js 仍注入 L0 全局变量", () => {
    const src = readFileSync(path.join(root, "lib/plugins/loader.js"), "utf8")
    expect(src).toMatch(/global\.plugin\s*=/)
    expect(src).toMatch(/global\.segment\s*=/)
  })

  it("内核与内置插件中的相对 import 均可解析", () => {
    const skip = new Set(["miao-plugin", "modules", "resources"])
    const files = [
      ...collectJsFiles(path.join(root, "lib"), [], skip),
      ...collectJsFiles(path.join(root, "plugins"), [], skip),
    ]

    // 自校验：若扫描范围意外为空，下面的断言会退化为永远通过
    expect(files.length, "扫描到的文件数过少，检查 collectJsFiles 的范围").toBeGreaterThan(30)

    let checked = 0
    const broken = []
    for (const file of files) {
      const src = readFileSync(file, "utf8")
      const specs = [
        ...[...src.matchAll(IMPORT_FROM_RE)].map(m => m[1]),
        ...[...src.matchAll(SIDE_EFFECT_IMPORT_RE)].map(m => m[1]),
      ]
      for (const spec of specs) {
        if (!spec.startsWith(".")) continue
        checked++
        const resolved = path.resolve(path.dirname(file), spec)
        const ok =
          existsSync(resolved) ||
          existsSync(`${resolved}.js`) ||
          existsSync(`${resolved}.json`) ||
          existsSync(path.join(resolved, "index.js"))
        if (!ok) broken.push(`${path.relative(root, file)} → ${spec}`)
      }
    }

    // 自校验：确实解析到了相对 import
    expect(checked, "未解析到任何相对 import，检查正则表达式").toBeGreaterThan(10)
    expect(broken).toEqual([])
  })
})
