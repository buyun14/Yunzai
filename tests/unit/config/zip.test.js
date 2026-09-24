import { describe, expect, it } from "vitest"
import { createZip, crc32, readZip } from "../../../lib/config/zip.js"

/**
 * 最小 ZIP 读写（阶段 5 §3.4）。
 *
 * 这里能证明的是"自己写得进、读得出"。**证明不了"别的工具也读得出"**——
 * 那是格式兼容性，只能拿外部工具验。所以另有一条独立验证：
 * `scripts/README` 记着用 PowerShell 的 `Expand-Archive` 与 `tar -xf`
 * 分别解一遍同一个包（见本文件末尾的说明）。
 */

describe("crc32", () => {
  it("与已知值一致（'123456789' 的 CRC-32 是 0xCBF43926）", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926)
  })

  it("空缓冲是 0", () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it("内容变一位，结果就变", () => {
    expect(crc32(Buffer.from("abc"))).not.toBe(crc32(Buffer.from("abd")))
  })
})

describe("createZip / readZip：往返", () => {
  it("文本与二进制都能原样取回", () => {
    const binary = Buffer.from([0, 1, 2, 250, 251, 252])
    const zip = createZip([
      { name: "manifest.json", data: '{"format_version":1}' },
      { name: "config/config/other.yaml", data: "masterQQ:\n  - 12345\n" },
      { name: "data/blob.bin", data: binary, compress: false },
    ])

    const entries = readZip(zip)
    expect(entries.map(entry => entry.name)).toEqual([
      "manifest.json",
      "config/config/other.yaml",
      "data/blob.bin",
    ])
    expect(entries[0].data.toString("utf8")).toBe('{"format_version":1}')
    expect(entries[1].data.toString("utf8")).toBe("masterQQ:\n  - 12345\n")
    expect(entries[2].data.equals(binary)).toBe(true)
  })

  it("UTF-8 文件名（中文路径）能取回，且打了 UTF-8 标志位", () => {
    const zip = createZip([{ name: "config/自定义.yaml", data: "a: 1\n" }])

    expect(readZip(zip)[0].name).toBe("config/自定义.yaml")
    // 本地头的标志位（偏移 6）bit 11 = 0x0800，缺了它别的工具会当成本地编码
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800)
  })

  it("空包也是合法的 ZIP", () => {
    expect(readZip(createZip([]))).toEqual([])
  })

  it("空文件能往返", () => {
    expect(readZip(createZip([{ name: "empty", data: "" }]))[0].data).toEqual(Buffer.alloc(0))
  })

  it("store 与 deflate 两种方式混用都没问题", () => {
    const entries = readZip(
      createZip([
        { name: "stored", data: "x".repeat(100), compress: false },
        { name: "deflated", data: "x".repeat(100), compress: true },
      ]),
    )
    expect(entries[0].data.toString()).toBe("x".repeat(100))
    expect(entries[1].data.toString()).toBe("x".repeat(100))
  })

  it("压缩确实起作用（重复内容变小）", () => {
    const text = "重复内容".repeat(500)
    const zip = createZip([{ name: "big.yaml", data: text }])
    expect(zip.length).toBeLessThan(Buffer.byteLength(text))
  })
})

describe("readZip：坏包必须报错，而不是解出半个结果", () => {
  it("内容被改一位，CRC-32 就抓得住", () => {
    const zip = createZip([{ name: "a.yaml", data: "key: value\n", compress: false }])
    // 本地头 30 字节 + 文件名 6 字节之后就是内容
    zip[36] ^= 0xff

    expect(() => readZip(zip)).toThrow(/CRC-32/)
  })

  it("不是 ZIP 时给一句能看懂的话", () => {
    expect(() => readZip(Buffer.from("这不是一个压缩包"))).toThrow(/中央目录结束记录/)
  })

  it("被截断的包会报错", () => {
    const zip = createZip([{ name: "a.yaml", data: "key: value\n" }])
    expect(() => readZip(zip.subarray(0, zip.length - 10))).toThrow()
  })

  it("条目数超过 ZIP64 边界时直接抛错，而不是写出坏包", () => {
    // 65536 个空条目：检查在遍历之前，所以这里只是一次数组长度判断
    const tooMany = Array.from({ length: 0x10000 }, (_, index) => ({
      name: `f${index}`,
      data: "",
    }))
    expect(() => createZip(tooMany)).toThrow(/ZIP64/)
  })
})
