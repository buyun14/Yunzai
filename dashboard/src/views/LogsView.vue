<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue"
import { ApiError, streamLogs } from "@/api/client"
import type { LogLine } from "@/api/types"
import { useAuthStore } from "@/stores/auth"
import { formatTime, levelColor } from "@/utils/format"

/**
 * 实时日志流（SSE）。
 *
 * # 关键约束（都来自后端，写错了表现都是「连上了但看不到东西」）
 *
 * - **必须能带请求头**：令牌要放在头里，而 `EventSource` **不支持自定义头**。
 *   所以走 `fetch` + `ReadableStream` 手动解析帧（实现见 `api/client.ts` 的 `streamLogs`）。
 * - **心跳是「连接还活着」的唯一信号**：服务端每 15 秒发一行 `: ping`。
 *   连着两个周期没收到就该重连——所以这里记 `lastPingAt` 并在界面上显示，
 *   而不是假装连接一直好着。
 * - **连上会先回放最近 200 条**（`?limit=` 可调），不是从空屏开始。
 * - **等级与分类是原样展示的**：`category` 是「哪个 logger 发的」（`message` 是默认
 *   logger 的名字），它就是排查时用来定位分类的依据，不做美化。
 *
 * 缓冲区在**前端**限长：SSE 是无限的，页面上留一个无限增长的数据结构
 * 只会让标签页越来越卡（后端自己的回放缓冲也只有 200 条）。
 */
const MAX_LINES = 2000
const PING_TIMEOUT_MS = 35000

const auth = useAuthStore()

const lines = ref<LogLine[]>([])
const connected = ref(false)
const connecting = ref(false)
const error = ref("")
const lastPingAt = ref(0)
const now = ref(Date.now())

const autoScroll = ref(true)
const keyword = ref("")
/** 关掉的等级。默认全开——但 `DEBUG`/`TRACE` 噪音大，初始就关掉更实用。 */
const hiddenLevels = ref<string[]>(["DEBUG", "TRACE"])

/**
 * 暂停（冻结视图）。
 *
 * ⚠️ **不断开连接**——这是关键。断开重连只能拿到后端最近 200 条的回放，
 * 暂停期间的日志会凭空消失；而"暂停"的用意恰恰是"让我看清眼前这些，
 * 别刷"或者"我去查个别的东西"。所以这里继续收，只是不往视图里放；
 * 恢复时把缓冲整段接上去，一条都不丢。
 */
const paused = ref(false)
/** 暂停期间收到的行。恢复时并入 `lines` */
const pending = ref<LogLine[]>([])
/** 暂停期间被丢弃的行数（超出 MAX_LINES 的） */
const droppedWhilePaused = ref(0)

let stop: (() => void) | null = null
let clock: number | undefined
let pingWatch: number | undefined

const viewport = useTemplateRef<HTMLElement>("viewport")

/** 心跳超时判定用的是一个每秒走一次的时钟，避免在渲染里直接读 Date.now() */
const pingAge = computed(() => (lastPingAt.value ? now.value - lastPingAt.value : 0))
const pingHealthy = computed(() => lastPingAt.value > 0 && pingAge.value < PING_TIMEOUT_MS)

const levels = computed(() => {
  const seen = new Set<string>()
  for (const line of lines.value) seen.add(line.level.toUpperCase())
  return [...seen].sort()
})

const categories = computed(() => {
  const seen = new Set<string>()
  for (const line of lines.value) seen.add(line.category)
  return [...seen].sort()
})

const shown = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return lines.value.filter(line => {
    if (hiddenLevels.value.includes(line.level.toUpperCase())) return false
    if (!kw) return true
    return (
      line.message.toLowerCase().includes(kw) ||
      line.category.toLowerCase().includes(kw) ||
      line.level.toLowerCase().includes(kw)
    )
  })
})

function connect(): void {
  disconnect()
  error.value = ""
  connecting.value = true
  connected.value = false
  lastPingAt.value = 0

  stop = streamLogs(
    {
      onOpen: () => {
        connected.value = true
        connecting.value = false
        lastPingAt.value = Date.now()
      },
      onPing: () => {
        lastPingAt.value = Date.now()
      },
      onLine: line => {
        // 暂停时不往视图里放，但要继续收——断开重连会丢日志（见 `paused` 的注释）
        if (paused.value) {
          pending.value.push(line)
          // 缓冲同样限长，否则"暂停一晚上"会把标签页吃爆
          if (pending.value.length > MAX_LINES) {
            const overflow = pending.value.length - MAX_LINES
            pending.value.splice(0, overflow)
            droppedWhilePaused.value += overflow
          }
          return
        }
        lines.value.push(line)
        // 前端的限长：超出就丢最旧的（与后端回放缓冲同样的策略）
        if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES)
      },
      onError: err => {
        connecting.value = false
        connected.value = false
        error.value = err.message
        if (err instanceof ApiError && err.isUnauthorized) auth.promptForToken()
      },
    },
    { limit: 200 },
  )
}

function disconnect(): void {
  stop?.()
  stop = null
  connected.value = false
  connecting.value = false
}

function reconnect(): void {
  connect()
}

function clearLines(): void {
  lines.value = []
  pending.value = []
  droppedWhilePaused.value = 0
}

/**
 * 切换暂停。
 *
 * 恢复时把缓冲整段接上去（而不是逐条），这样只触发一次渲染，
 * 暂停期间攒了几千条也不会卡住。
 */
function togglePause(): void {
  if (paused.value) {
    if (pending.value.length) {
      lines.value.push(...pending.value)
      const overflow = lines.value.length - MAX_LINES
      if (overflow > 0) lines.value.splice(0, overflow)
      pending.value = []
    }
    paused.value = false
    // 恢复后贴回底部（暂停期间用户可能上滚过）
    autoScroll.value = true
    void nextTick(() => {
      const el = viewport.value
      if (el) el.scrollTop = el.scrollHeight
    })
    return
  }
  paused.value = true
}

/**
 * 导出当前**过滤后**的日志为文本文件。
 *
 * 导出的是 `shown`（屏幕上看到的这些），不是 `lines`——用户在搜索框里筛过之后
 * 点导出，期待的是筛出来的结果，把没显示的也导出去会让人以为过滤没生效。
 *
 * 文本格式与终端观感对齐：`时间 [等级] 分类 消息`，等级左对齐补齐，
 * 这样导出的文件用编辑器打开也是一列一列的。
 */
function exportLines(): void {
  if (!shown.value.length) return
  const text = shown.value
    .map(line => {
      const level = line.level.toUpperCase().padEnd(5)
      return `${new Date(line.time).toISOString()} [${level}] ${line.category} ${line.message}`
    })
    .join("\n")

  // 文件名带本地时间，避免下载目录里一堆同名文件互相覆盖。
  // 用 `toISOString()` 会在跨时区时给出"昨天"的日期，所以这里按本地时间拼
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `yunzai-logs-${stamp}.txt`
  a.click()
  // ⚠️ 不能立刻 revoke。实测：同步 revoke 会让下载取不到数据，而且**不报错**，
  // 表现为"点了导出、什么都没发生、下载目录里也没有文件"。
  // 下载是异步去取 blob 的，所以要等它取完再释放。
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function toggleLevel(level: string): void {
  if (hiddenLevels.value.includes(level))
    hiddenLevels.value = hiddenLevels.value.filter(item => item !== level)
  else hiddenLevels.value = [...hiddenLevels.value, level]
}

/**
 * 用户手动往上滚时关掉自动滚动，滚回底部时再打开。
 *
 * 用一个 40px 的容差而不是严格相等：日志是持续增长的，
 * 「正好在底部」这个瞬间很难命中，严格判断会让自动滚动再也打不开。
 */
function onScroll(event: Event): void {
  const el = event.target as HTMLElement
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}

/** 新日志到达后，如果开着自动滚动就贴到底部 */
watch(
  () => shown.value.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    const el = viewport.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

onMounted(() => {
  clock = window.setInterval(() => (now.value = Date.now()), 1000)
  // 心跳断了就自动重连，不需要人盯着
  pingWatch = window.setInterval(() => {
    if (connected.value && !pingHealthy.value) connect()
  }, 5000)
  connect()
})

onUnmounted(() => {
  disconnect()
  if (clock !== undefined) clearInterval(clock)
  if (pingWatch !== undefined) clearInterval(pingWatch)
})

const connectionText = computed(() => {
  if (connecting.value) return "连接中…"
  if (!connected.value) return "已断开"
  if (!pingHealthy.value) return "心跳超时"
  return lastPingAt.value ? `已连接（心跳 ${Math.round(pingAge.value / 1000)} 秒前）` : "已连接"
})

const connectionColor = computed(() => {
  if (connecting.value) return "info"
  if (!connected.value || !pingHealthy.value) return "error"
  return "success"
})
</script>

<template>
  <div>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-h6">实时日志</h2>
      <v-chip :color="connectionColor" size="small" variant="flat">{{ connectionText }}</v-chip>
      <v-chip size="small" variant="tonal">{{ lines.length }} / {{ MAX_LINES }} 条</v-chip>
      <v-spacer />
      <v-text-field
        v-model="keyword"
        placeholder="过滤内容 / 分类 / 等级"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="outlined"
        hide-details
        clearable
        style="max-width: 280px"
      />
      <v-switch
        v-model="autoScroll"
        label="自动滚动"
        color="primary"
        density="compact"
        hide-details
        :disabled="paused"
      />
      <v-btn
        data-testid="logs-pause"
        :color="paused ? 'warning' : undefined"
        :variant="paused ? 'flat' : 'tonal'"
        size="small"
        :prepend-icon="paused ? 'mdi-play' : 'mdi-pause'"
        @click="togglePause()"
      >
        {{ paused ? `继续${pending.length ? `（+${pending.length}）` : ""}` : "暂停" }}
      </v-btn>
      <v-btn
        data-testid="logs-export"
        variant="tonal"
        size="small"
        prepend-icon="mdi-download"
        :disabled="!shown.length"
        @click="exportLines()"
      >
        导出
      </v-btn>
      <v-btn variant="tonal" size="small" prepend-icon="mdi-broom" @click="clearLines()">
        清空
      </v-btn>
      <v-btn
        variant="tonal"
        size="small"
        prepend-icon="mdi-refresh"
        :loading="connecting"
        @click="reconnect()"
      >
        重连
      </v-btn>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :title="error">
      <template #append>
        <v-btn variant="text" size="small" prepend-icon="mdi-refresh" @click="reconnect()">
          重试
        </v-btn>
      </template>
    </v-alert>

    <!-- 暂停态必须有明显提示：否则"日志怎么不更新了"会被当成又坏了 -->
    <v-alert
      v-if="paused"
      data-testid="logs-paused-notice"
      type="warning"
      variant="tonal"
      density="comfortable"
      class="mb-4"
    >
      视图已暂停（<strong>连接没断</strong>，日志仍在后台累积）。 恢复后会一次性补上这
      {{ pending.length }} 条。
      <template v-if="droppedWhilePaused">
        超过 {{ MAX_LINES }} 条上限的 {{ droppedWhilePaused }} 条已被丢弃。
      </template>
    </v-alert>

    <v-card variant="outlined" class="mb-3">
      <v-card-text class="d-flex flex-wrap align-center ga-2 py-2">
        <span class="text-caption text-medium-emphasis mr-2">等级</span>
        <v-chip
          v-for="level in levels"
          :key="level"
          :color="hiddenLevels.includes(level) ? undefined : levelColor(level)"
          :variant="hiddenLevels.includes(level) ? 'outlined' : 'flat'"
          size="small"
          @click="toggleLevel(level)"
        >
          {{ level }}
        </v-chip>
        <span v-if="!levels.length" class="text-caption text-medium-emphasis">还没有日志</span>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          分类：{{ categories.join(" / ") || "—" }}
        </span>
      </v-card-text>
    </v-card>

    <v-card variant="outlined">
      <div ref="viewport" class="log-viewport" @scroll.passive="onScroll">
        <div v-if="!shown.length" class="pa-6 text-center text-medium-emphasis">
          <span v-if="!lines.length">还没有日志。宿主有输出时这里会实时出现。</span>
          <span v-else>当前过滤条件下没有日志。</span>
        </div>
        <div v-for="(line, i) in shown" :key="i" class="log-line">
          <span class="log-time">{{ formatTime(line.time) }}</span>
          <v-chip :color="levelColor(line.level)" size="x-small" variant="flat" class="log-level">
            {{ line.level }}
          </v-chip>
          <span class="log-category">{{ line.category }}</span>
          <span class="log-message">{{ line.message }}</span>
        </div>
      </div>
    </v-card>

    <p class="text-caption text-medium-emphasis mt-2">
      服务端每 15 秒发一个心跳；连接后先回放最近 200 条。 日志来源是给 log4js 追加的
      appender，与终端是同一份事件。
    </p>
  </div>
</template>

<style scoped>
.log-viewport {
  max-height: 60vh;
  min-height: 320px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  padding: 8px 12px;
  /* 深色底更容易分辨日志等级，也与终端观感一致 */
  background: #1e1e1e;
  color: #d4d4d4;
}

.log-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  /* 长日志不折行会撑破布局；折行 + 保留缩进更适合阅读堆栈 */
  white-space: pre-wrap;
  word-break: break-word;
}

.log-time {
  color: #808080;
  flex: 0 0 auto;
}

.log-level {
  flex: 0 0 auto;
}

.log-category {
  color: #569cd6;
  flex: 0 0 auto;
}

.log-message {
  flex: 1 1 auto;
}
</style>
