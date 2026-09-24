import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { collectDiff, diffFlattened, flattenConfig, formatDiff } from "../../../lib/config/diff.js"

/**
 * 配置差异报告（阶段 5 §3.2）。
 *
 * 对应的验收项（`05-persistence-config.md` §6）：`node . config:diff` 输出用户配置与
 * 默认配置的差异。全部在临时目录里跑，绝不碰真实的 `config/config/`。
 */

let root
/** 用户配置目录 */
let configDir
/** 出厂默认目录 */
let defaultsDir

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yz-diff-"))
  configDir = path.join(root, "config")
  defaultsDir = path.join(root, "default_config")
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(defaultsDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * 往某个目录里写一个 yaml。
 *
 * @param {"config"|"default_config"} dir 目标目录
 * @param {string} name 文件名
 * @param {string} body 内容
 * @returns {Promise<void>}
 */
function write(dir, name, body) {
  return fs.writeFile(path.join(root, dir, name), body)
}

/** 跑一次差异收集 */
function run() {
  return collectDiff({ configDir, defaultsDir })
}

describe("flattenConfig", () => {
  it("嵌套对象压成点号路径", () => {
    expect([...flattenConfig({ a: { b: { c: 1 } }, d: 2 })]).toEqual([
      ["a.b.c", 1],
      ["d", 2],
    ])
  })

  it("数组是叶子，不按下标展开", () => {
    expect([...flattenConfig({ list: [1, 2] })]).toEqual([["list", [1, 2]]])
  })

  it("空对象不产出条目，空字符串与 0 要保留", () => {
    expect([...flattenConfig({ empty: {}, s: "", n: 0, nil: null })]).toEqual([
      ["s", ""],
      ["n", 0],
      ["nil", null],
    ])
  })
})

describe("diffFlattened", () => {
  it("分出「待补」「多余」「不同」三类", () => {
    const user = new Map([
      ["keep", 1],
      ["change", "old"],
      ["extra", true],
    ])
    const defaults = new Map([
      ["keep", 1],
      ["change", "new"],
      ["missing", 5],
    ])

    expect(diffFlattened(user, defaults)).toEqual({
      missing: [{ key: "missing", default: 5 }],
      extra: [{ key: "extra", user: true }],
      changed: [{ key: "change", user: "old", default: "new" }],
    })
  })

  it("数组按整体比较：顺序不同算「不同」", () => {
    const diff = diffFlattened(new Map([["l", [2, 1]]]), new Map([["l", [1, 2]]]))
    expect(diff.changed).toHaveLength(1)
  })
})

describe("collectDiff", () => {
  it("逐文件给出三类差异与汇总", async () => {
    await write("config", "other.yaml", "a: 1\nb: changed\nmine: true\n")
    await write("default_config", "other.yaml", "a: 1\nb: default\nnewKey: 5\n")

    const result = await run()

    expect(result.files).toHaveLength(1)
    expect(result.files[0].name).toBe("other.yaml")
    expect(result.files[0].status).toBe("both")
    expect(result.files[0].missing.map(item => item.key)).toEqual(["newKey"])
    expect(result.files[0].extra.map(item => item.key)).toEqual(["mine"])
    expect(result.files[0].changed.map(item => item.key)).toEqual(["b"])
    expect(result.summary).toEqual({ files: 1, missing: 1, extra: 1, changed: 1 })
  })

  it("用户多建的文件与默认新增的文件都会被标出来", async () => {
    await write("config", "only-user.yaml", "x: 1\n")
    await write("default_config", "only-default.yaml", "y: 2\n")

    const result = await run()

    expect(result.files.map(file => `${file.name}:${file.status}`)).toEqual([
      "only-default.yaml:only-default",
      "only-user.yaml:only-user",
    ])
    // 只有一个文件里有内容时不算"键级差异"——文件级状态已经说清了
    expect(result.summary.missing + result.summary.extra).toBe(0)
  })

  it("完全一致时没有任何文件被列出", async () => {
    await write("config", "same.yaml", "a:\n  b: 1\n")
    await write("default_config", "same.yaml", "a:\n  b: 1\n")

    const result = await run()

    expect(result.files).toEqual([])
    expect(result.summary.files).toBe(0)
  })

  it("坏掉的 yaml 当空配置处理，不抛异常", async () => {
    await write("config", "broken.yaml", "{这不是合法 yaml\n")
    await write("default_config", "broken.yaml", "a: 1\n")

    const result = await run()

    expect(result.summary.missing).toBe(1)
  })

  it("两个目录都不存在时返回空结果，不抛异常", async () => {
    const result = await collectDiff({
      configDir: path.join(root, "无"),
      defaultsDir: path.join(root, "也无"),
    })
    expect(result.files).toEqual([])
  })

  it("只读：跑完不新增、不改动任何文件", async () => {
    await write("config", "other.yaml", "a: 1\nb: 2\n")
    await write("default_config", "other.yaml", "a: 1\n")
    const before = await fs.readFile(path.join(configDir, "other.yaml"), "utf8")

    await run()

    expect(await fs.readdir(configDir)).toEqual(["other.yaml"])
    expect(await fs.readFile(path.join(configDir, "other.yaml"), "utf8")).toBe(before)
  })
})

describe("formatDiff", () => {
  it("没有差异时给一句明确的话", () => {
    expect(formatDiff({ files: [], summary: { files: 0, missing: 0, extra: 0, changed: 0 } })).toContain(
      "没有差异。",
    )
  })

  it("列出文件名、键名与汇总", async () => {
    await write("config", "other.yaml", "b: changed\n")
    await write("default_config", "other.yaml", "b: default\nnewKey: 5\n")

    const text = formatDiff(await run())

    expect(text).toContain("other.yaml")
    expect(text).toContain("newKey")
    expect(text).toContain("待补 1 项")
    expect(text).toContain("只读")
  })

  it("超过条数上限时明确写出还有多少没列", async () => {
    const defaults = Array.from({ length: 30 }, (_, index) => `k${index}: ${index}`).join("\n")
    await write("config", "big.yaml", "")
    await write("default_config", "big.yaml", `${defaults}\n`)

    const text = formatDiff(await run(), { limit: 5 })

    expect(text).toContain("另有 25 条未列出")
    expect(text).toContain("--all")
  })
})
