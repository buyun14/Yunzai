import { deflateRawSync, inflateRawSync } from "node:zlib"

/**
 * 最小 ZIP 读写，只覆盖备份包需要的那部分。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.4 与开放问题 Q3。
 *
 * # 为什么自己实现而不是装依赖
 *
 * Q3 的结论是"ZIP 优先，只有嫌它需要依赖时才退化为 tar.gz"。而 ZIP 并不真的
 * 需要依赖：格式完全公开，本节用到的只是「deflate + 本地头 + 中央目录 + EOCD」
 * 这一小块。相比之下 `archiver` 这类库会拉进一棵不小的依赖树，而备份包本身
 * 只有几 MB 配置——为它引入运行期依赖不划算。
 *
 * 另一个理由是**可验证**：产出的包能用系统自带工具打开（Windows 资源管理器、
 * `Expand-Archive`、`tar -xf`）。只有这样，"备份能恢复"才不只是"我自己的读函数
 * 能读我自己的写函数"。
 *
 * # 明确不支持的部分（有意为之，不是遗漏）
 *
 * - **ZIP64**：条目数 > 65535 或单文件 ≥ 4GiB 时**抛错**，而不是产出一个坏包。
 *   配置与 `data/`（已排除 `temp/`、`logs/`）不可能到这个量级；真到了，
 *   该做的是重新考虑备份策略，而不是悄悄写一个多数工具读不了的包。
 * - **加密、数据描述符（data descriptor）、多卷、目录条目**：写侧不产出这些，
 *   读侧遇到也不认（会报错）。本模块的读只保证能读**本模块写出的包**——
 *   对外来 ZIP 不做承诺，也就不会给出错误的成功。
 */

/** 本地文件头签名 */
const LOCAL_SIG = 0x04034b50
/** 中央目录条目签名 */
const CENTRAL_SIG = 0x02014b50
/** 中央目录结束记录签名 */
const EOCD_SIG = 0x06054b50

/** 用 deflate 压缩 */
const METHOD_DEFLATE = 8
/** 原样存储（已压缩过的内容再压一次只是白费 CPU） */
const METHOD_STORE = 0

/** 文件名是 UTF-8（bit 11）。缺了它，中文路径在别的工具里会变成乱码 */
const FLAG_UTF8 = 0x0800

/** 单个文件的大小上限（ZIP64 边界） */
const MAX_ENTRY_SIZE = 0xffffffff
/** 条目数上限（ZIP64 边界） */
const MAX_ENTRIES = 0xffff

/** CRC-32 查表，按需构建一次 */
let crcTable = null

/**
 * 算 CRC-32。
 *
 * ZIP 每个条目都要带它，用途只有一个：让**读的人**能判断内容有没有坏。
 * 恢复配置时这一点很关键——一个静默损坏的 yaml 比一个打不开的包危险得多。
 *
 * @param {Buffer} buffer 内容
 * @returns {number} CRC-32（无符号 32 位）
 */
export function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[index] = value >>> 0
    }
  }

  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 把时间转成 DOS 日期/时间（ZIP 用的是 1980 纪元的打包格式）。
 *
 * @param {Date} date 时间
 * @returns {{ time: number, date: number }} DOS 时间与日期
 */
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 打一个 ZIP 包。
 *
 * @param {Array<{ name: string, data: Buffer | string, compress?: boolean, date?: Date }>} entries 条目
 *   `name` 用 `/` 分隔（ZIP 规范如此，与平台无关）；`compress` 默认 true，
 *   已经压过的内容（图片等）传 false 更省 CPU
 * @returns {Buffer} ZIP 内容
 */
export function createZip(entries) {
  if (entries.length > MAX_ENTRIES)
    throw new Error(`条目数 ${entries.length} 超过 ${MAX_ENTRIES}，本模块不支持 ZIP64`)

  const chunks = []
  /** @type {Array<{ name: Buffer, crc: number, size: number, packed: number, offset: number, method: number, time: number, date: number }>} */
  const records = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8")
    if (raw.length >= MAX_ENTRY_SIZE)
      throw new Error(`条目 ${entry.name} 有 ${raw.length} 字节，达到 ZIP64 边界，本模块不支持`)

    const method = entry.compress === false ? METHOD_STORE : METHOD_DEFLATE
    const body = method === METHOD_DEFLATE ? deflateRawSync(raw, { level: 6 }) : raw
    const { time, date } = dosDateTime(entry.date ?? new Date())
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_SIG, 0)
    header.writeUInt16LE(20, 4) // 需要的版本：2.0
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28) // 扩展字段长度

    chunks.push(header, name, body)
    records.push({
      name,
      crc,
      size: raw.length,
      packed: body.length,
      offset,
      method,
      time,
      date,
    })
    offset += header.length + name.length + body.length
  }

  const centralOffset = offset
  for (const record of records) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_SIG, 0)
    header.writeUInt16LE(20, 4) // 创建版本
    header.writeUInt16LE(20, 6) // 解压所需版本
    header.writeUInt16LE(FLAG_UTF8, 8)
    header.writeUInt16LE(record.method, 10)
    header.writeUInt16LE(record.time, 12)
    header.writeUInt16LE(record.date, 14)
    header.writeUInt32LE(record.crc, 16)
    header.writeUInt32LE(record.packed, 20)
    header.writeUInt32LE(record.size, 24)
    header.writeUInt16LE(record.name.length, 28)
    header.writeUInt16LE(0, 30) // 扩展字段
    header.writeUInt16LE(0, 32) // 注释
    header.writeUInt16LE(0, 34) // 磁盘号
    header.writeUInt16LE(0, 36) // 内部属性
    header.writeUInt32LE(0, 38) // 外部属性
    header.writeUInt32LE(record.offset, 42)

    chunks.push(header, record.name)
    offset += header.length + record.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(0, 4) // 本磁盘号
  end.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  end.writeUInt16LE(records.length, 8)
  end.writeUInt16LE(records.length, 10)
  end.writeUInt32LE(offset - centralOffset, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20) // 注释长度
  chunks.push(end)

  return Buffer.concat(chunks)
}

/**
 * 读一个由本模块打出的 ZIP 包。
 *
 * 每个条目都会**校验 CRC-32 与长度**：配置备份最怕的不是打不开，而是
 * 悄悄解出一份内容不对的 yaml。校验不过直接抛错，不返回半个结果。
 *
 * @param {Buffer} buffer ZIP 内容
 * @returns {Array<{ name: string, data: Buffer }>} 条目
 */
export function readZip(buffer) {
  const eocd = findEocd(buffer)
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIG)
      throw new Error(`中央目录第 ${index + 1} 条的签名不对，包可能已损坏`)

    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const packed = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength)

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG)
      throw new Error(`条目 ${name} 的本地头签名不对，包可能已损坏`)

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const body = buffer.subarray(start, start + packed)

    let data
    if (method === METHOD_STORE) data = Buffer.from(body)
    else if (method === METHOD_DEFLATE) data = inflateRawSync(body)
    else throw new Error(`条目 ${name} 用了不支持的压缩方式 ${method}（本模块只写 deflate / store）`)

    if (data.length !== size)
      throw new Error(`条目 ${name} 解出 ${data.length} 字节，包头声明 ${size} 字节`)
    if (crc32(data) !== crc) throw new Error(`条目 ${name} 的 CRC-32 校验不过，内容已损坏`)

    entries.push({ name, data })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

/**
 * 从尾部往前找 EOCD。
 *
 * EOCD 在最后 22 字节，但它后面还可能有注释（最长 65535 字节），
 * 所以要在最后 65557 字节里回扫。
 *
 * @param {Buffer} buffer ZIP 内容
 * @returns {number} EOCD 的偏移
 */
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - (22 + 0xffff))

  for (let offset = buffer.length - 22; offset >= start; offset--)
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset

  throw new Error("没找到 ZIP 的中央目录结束记录：这不是一个完整的 ZIP 包，或者它用了本模块不支持的 ZIP64")
}
