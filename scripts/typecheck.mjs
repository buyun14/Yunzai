#!/usr/bin/env node
/**
 * 运行 tsc 并按路径过滤报错，只统计本仓自有代码。
 *
 * 背景：jsconfig.json 开启 `checkJs` 后，TypeScript 会把通过 import 传递到达的
 * 第三方 `.js` 文件（`node_modules/**`、`plugins/miao-plugin/**`）一并纳入检查，
 * 这些报错不受本仓控制，会让闸门永远无法收敛为零。
 *
 * 用法：`node scripts/typecheck.mjs [--json]`
 * 退出码：自有代码存在报错时非零。
 */

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

/** 不属于本仓控制范围、不计入闸门的路径前缀（正斜杠形式） */
const IGNORED_PREFIXES = ["node_modules/", "plugins/miao-plugin/"]

const root = fileURLToPath(new URL("../", import.meta.url))
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc")

const result = spawnSync(
  process.execPath,
  [tsc, "-p", "jsconfig.json", "--noEmit", "--pretty", "false"],
  { cwd: root, encoding: "utf8" },
)

if (result.error) {
  console.error("无法启动 tsc：", result.error.message)
  process.exit(2)
}

const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => /error TS\d+/.test(l))

const own = []
const ignored = []
for (const line of lines) {
  const file = line.slice(0, line.indexOf("(")).replace(/\\/g, "/")
  if (IGNORED_PREFIXES.some(p => file.startsWith(p))) ignored.push(line)
  else own.push(line)
}

const byFile = new Map()
for (const line of own) {
  const file = line.slice(0, line.indexOf("(")).replace(/\\/g, "/")
  byFile.set(file, (byFile.get(file) ?? 0) + 1)
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      { own: own.length, ignored: ignored.length, byFile: Object.fromEntries(byFile) },
      null,
      2,
    ),
  )
} else {
  for (const line of own) console.log(line)
  console.log("")
  console.log("按文件统计（自有代码）：")
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(count).padStart(4)}  ${file}`)
  console.log("")
  console.log(
    `自有代码报错 ${own.length} 处，第三方（node_modules / miao-plugin）${ignored.length} 处（不计入闸门）。`,
  )
  if (own.length) {
    console.log("基线见 docs/refactor/baseline/static-analysis.md，要求只降不升。")
  }
}

process.exit(own.length ? 1 : 0)
