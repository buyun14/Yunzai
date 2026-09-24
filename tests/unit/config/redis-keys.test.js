import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  CACHE_PREFIX,
  cacheKey,
  KEY_ROOT,
  PERSIST_PREFIX,
  persistKey,
} from "../../../lib/config/redis-keys.js"

/**
 * Redis 键的前缀规范（阶段 5 §3.3）。
 *
 * 除了测拼接，更重要的是最后那条守卫：这类改造最典型的失败方式是**只改一半**
 * （写端改前缀、读端忘了），而后果是静默的——`plugins/system/status.js`
 * 读不到东西时返回 0，不会报错。守卫测试把"手拼的旧键"直接变成失败。
 */

/** 仓库根 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url))

describe("前缀", () => {
  it("两个类别都挂在既有命名空间下", () => {
    expect(KEY_ROOT).toBe("Yz")
    expect(CACHE_PREFIX).toBe("Yz:cache")
    expect(PERSIST_PREFIX).toBe("Yz:persist")
  })

  it("拼接用冒号连接，数字段也能接", () => {
    expect(cacheKey("loginMsg", 12345)).toBe("Yz:cache:loginMsg:12345")
    expect(persistKey("count", "receive", "x:y")).toBe("Yz:persist:count:receive:x:y")
  })

  it("同一个名字在两类里不会撞键", () => {
    expect(cacheKey("a")).not.toBe(persistKey("a"))
  })
})

describe("守卫：不许再手拼 Yz: 键", () => {
  /** 要检查的目录（`plugins/miao-plugin` 是第三方，有自己的 `miao:` 命名空间，不查） */
  const SCOPE = ["lib", "plugins/system", "plugins/other", "plugins/utils", "plugins/example"]

  /**
   * 递归列出 .js 文件。
   *
   * @param {string} dir 目录
   * @returns {Promise<string[]>} 文件相对路径
   */
  async function listJs(dir) {
    const result = []
    let entries
    try {
      entries = await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })
    } catch {
      return result
    }
    for (const entry of entries) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) result.push(...(await listJs(rel)))
      else if (entry.name.endsWith(".js")) result.push(rel)
    }
    return result
  }

  it("没有形如 `Yz:...` 的键字面量（redis-keys.js 自己除外）", async () => {
    const offenders = []
    for (const dir of SCOPE)
      for (const file of await listJs(dir)) {
        if (file === "lib/config/redis-keys.js") continue
        const text = await fs.readFile(path.join(ROOT, file), "utf8")
        for (const [index, line] of text.split("\n").entries())
          if (/[`"']Yz:/.test(line)) offenders.push(`${file}:${index + 1}  ${line.trim()}`)
      }

    expect(offenders, `这些地方还在手拼 Yz: 键，应改用 cacheKey() / persistKey()：\n${offenders.join("\n")}`).toEqual([])
  })

  it("count 的读写两端用的是同一个前缀函数", async () => {
    // 写端在 loader.js，读端在 status.js。它们必须一致，否则统计会静默变成 0
    const writer = await fs.readFile(path.join(ROOT, "lib/plugins/loader.js"), "utf8")
    const reader = await fs.readFile(path.join(ROOT, "plugins/system/status.js"), "utf8")

    expect(writer).toMatch(/persistKey\("count"/)
    expect(reader).toMatch(/persistKey\("count"/)
  })
})
