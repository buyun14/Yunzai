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
      />
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
