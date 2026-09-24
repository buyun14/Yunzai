/**
 * 展示层的格式化。纯函数，没有 Vue 依赖。
 *
 * 与后端的契约边界很清楚：**后端给结构化数据，人话在这里拼**。
 * 所以像「1天2小时3分」这种给运维看的写法不进 API（那会让契约随文案漂移）。
 */

/**
 * 秒 → 人话。用于 `uptime` 与日志的相对时间。
 *
 * @param seconds 秒数
 * @returns 形如 `1天2小时3分` / `5分12秒` / `8秒`
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  if (days > 0) return `${days}天${hours}小时${minutes}分`
  if (hours > 0) return `${hours}小时${minutes}分`
  if (minutes > 0) return `${minutes}分${secs}秒`
  return `${secs}秒`
}

/**
 * MB → 人话。`status.memory` 给的就是 MB。
 *
 * @param mb 兆字节
 * @returns 形如 `108.41 MB` / `1.20 GB`
 */
export function formatMB(mb: number): string {
  if (!Number.isFinite(mb)) return "—"
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(2)} MB`
}

/**
 * 时间戳 → `HH:MM:SS`。日志行用**本地时间**：运维看的是「刚才发生了什么」，
 * 与终端对照，所以要跟终端同一个时区。
 *
 * @param time 毫秒时间戳
 * @returns 时刻
 */
export function formatTime(time: number): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return "—"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 把服务端的 `stat.online` 翻成中文。
 *
 * `undefined` 也要处理：`/ready` 的 `online` 是可选的（契约里没进 `required`）。
 *
 * @param online 状态值
 * @returns 文案
 */
export function describeOnline(online: number | undefined): string {
  switch (online) {
    case 0:
      return "未启动"
    case 1:
      return "启动中"
    case 2:
      return "已上线"
    default:
      return "未知"
  }
}

/**
 * 日志等级 → Vuetify 的颜色名。
 *
 * 与 log4js 的等级名对齐（大小写已由后端统一成大写）。`MARK` 是本项目自己的
 * 「值得记一笔」等级，给一个中性但醒目的颜色。
 *
 * @param level 等级名
 * @returns Vuetify 颜色
 */
export function levelColor(level: string): string {
  switch (level.toUpperCase()) {
    case "FATAL":
    case "ERROR":
      return "error"
    case "WARN":
      return "warning"
    case "MARK":
      return "primary"
    case "DEBUG":
    case "TRACE":
      return "grey"
    default:
      return "success"
  }
}
