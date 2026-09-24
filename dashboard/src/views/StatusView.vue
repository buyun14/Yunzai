<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue"
import { getReady, getStatus } from "@/api/client"
import type { Status } from "@/api/types"
import PanelState from "@/components/PanelState.vue"
import { useAsync } from "@/composables/useAsync"
import { describeOnline, formatDuration, formatMB } from "@/utils/format"

/**
 * 状态总览。
 *
 * # 为什么先打 `/ready` 再打 `/status`
 *
 * 两者都挂了，但**失败的形态不一样**，用同一个错误提示会把人带偏：
 *
 * - 宿主还没上线时，`/ready` 与 `/status` 都会被 WebUI 的早期探针就地答复
 *   `503` + `Retry-After`（`lib/web/server.js` 的 `earlyProbe`）。这是**正常**的启动期状态；
 * - 已上线但 `/status` 失败，那才是真问题。
 *
 * 所以这里把「等就绪」显式做成一个会自动重试的等待态，而不是显示一个红色错误。
 * 这也是 `06-webui.md` §5 那条验收（「启动期不出现无限转圈」）的前端一半。
 */
const AUTO_REFRESH_MS = 5000
/** 启动期的重试间隔：与早期探针给的 `Retry-After: 2` 对齐 */
const READY_RETRY_MS = 2000

const autoRefresh = ref(true)
/** 就绪等待的提示文案；为空表示没有在等 */
const waiting = ref("")

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

const { data, error, loading, loadedAt, refresh } = useAsync<Status>(async init => {
  // 启动期重试：只有 503 才继续等，其余错误立刻冒出去（别把真问题藏进重试里）
  const signal = init.signal as AbortSignal
  for (let attempt = 1; ; attempt++) {
    try {
      await getReady(init)
      waiting.value = ""
      break
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status !== 503) throw err
      waiting.value = `宿主尚未就绪（第 ${attempt} 次探测），正在等待适配器上线…`
      await delay(READY_RETRY_MS, signal)
    }
  }
  return getStatus(init)
})

let timer: number | undefined
function syncTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  if (!autoRefresh.value) return
  timer = window.setInterval(() => void refresh(), AUTO_REFRESH_MS)
}
syncTimer()
onUnmounted(() => timer !== undefined && clearInterval(timer))

/** 手动刷新顺带把自动刷新的节奏重置，避免刚点完又立刻被定时器刷一次 */
function manualRefresh(): void {
  void refresh()
  syncTimer()
}

const cards = computed(() => {
  const s = data.value
  if (!s) return []
  return [
    { title: "宿主版本", value: s.version, icon: "mdi-tag-outline" },
    {
      title: "在线状态",
      value: describeOnline(s.online),
      icon: "mdi-lan-connect",
      color: s.online === 2 ? "success" : "warning",
    },
    { title: "运行时长", value: formatDuration(s.uptime), icon: "mdi-timer-outline" },
    { title: "内存 RSS", value: formatMB(s.memory.rss), icon: "mdi-memory" },
    { title: "堆已用", value: formatMB(s.memory.heapUsed), icon: "mdi-chart-donut" },
    { title: "堆总量", value: formatMB(s.memory.heapTotal), icon: "mdi-chart-arc" },
  ]
})

const lastUpdated = computed(() =>
  loadedAt.value ? new Date(loadedAt.value).toLocaleTimeString() : "—",
)
</script>

<template>
  <div>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-h6">状态总览</h2>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">更新于 {{ lastUpdated }}</span>
      <v-switch
        v-model="autoRefresh"
        label="自动刷新"
        color="primary"
        density="compact"
        hide-details
        class="ml-2"
        @update:model-value="syncTimer()"
      />
      <v-btn
        prepend-icon="mdi-refresh"
        variant="tonal"
        size="small"
        :loading="loading"
        @click="manualRefresh()"
      >
        刷新
      </v-btn>
    </div>

    <!-- 启动期的等待态：这是正常状态，所以用 info 而不是 error -->
    <v-alert v-if="waiting" type="info" variant="tonal" class="mb-4">
      {{ waiting }}
    </v-alert>

    <PanelState
      :loading="loading"
      :error="error"
      :empty="!data"
      empty-text="还没有拿到状态数据"
      :on-retry="manualRefresh"
    >
      <template v-if="data">
        <v-row dense>
          <v-col v-for="card in cards" :key="card.title" cols="12" sm="6" md="4">
            <v-card variant="tonal" :color="card.color">
              <v-card-item :prepend-icon="card.icon" :title="card.title" />
              <v-card-text class="text-h6">{{ card.value }}</v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <v-row dense class="mt-1">
          <v-col cols="12" md="4">
            <v-card variant="outlined" height="100%">
              <v-card-item prepend-icon="mdi-puzzle-outline" title="插件" />
              <v-card-text>
                <v-list density="compact">
                  <v-list-item title="调度条目" :subtitle="String(data.plugins.handlers)" />
                  <v-list-item title="插件类" :subtitle="String(data.plugins.loaded)" />
                  <v-list-item title="定时任务" :subtitle="String(data.plugins.tasks)" />
                </v-list>
              </v-card-text>
            </v-card>
          </v-col>

          <v-col cols="12" md="4">
            <v-card variant="outlined" height="100%">
              <v-card-item prepend-icon="mdi-connection" title="适配器" />
              <v-card-text>
                <template v-if="data.adapters.length">
                  <v-chip
                    v-for="(adapter, i) in data.adapters"
                    :key="`${adapter.id}-${i}`"
                    class="ma-1"
                    size="small"
                    variant="tonal"
                    :title="adapter.id ?? ''"
                  >
                    {{ adapter.name || adapter.id || "未命名" }}
                  </v-chip>
                </template>
                <span v-else class="text-medium-emphasis">未注册适配器</span>
              </v-card-text>
            </v-card>
          </v-col>

          <v-col cols="12" md="4">
            <v-card variant="outlined" height="100%">
              <v-card-item prepend-icon="mdi-account-multiple-outline" title="账号" />
              <v-card-text>
                <template v-if="data.accounts.length">
                  <v-chip
                    v-for="account in data.accounts"
                    :key="account.uin"
                    class="ma-1"
                    size="small"
                    variant="tonal"
                  >
                    {{ account.uin }}
                  </v-chip>
                  <p class="text-caption text-medium-emphasis mt-2">
                    v1 只列账号，不判断是否在线。
                  </p>
                </template>
                <span v-else class="text-medium-emphasis">没有已登录的账号</span>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <v-card variant="outlined" class="mt-4">
          <v-card-item prepend-icon="mdi-cog-outline" title="运行时" />
          <v-card-text>
            <v-table density="compact">
              <tbody>
                <tr>
                  <th class="text-left" style="width: 160px">Node</th>
                  <td>{{ data.runtime.node }}</td>
                </tr>
                <tr>
                  <th class="text-left">平台 / 架构</th>
                  <td>{{ data.runtime.platform }} / {{ data.runtime.arch }}</td>
                </tr>
                <tr>
                  <th class="text-left">进程 PID</th>
                  <td>{{ data.runtime.pid }}</td>
                </tr>
              </tbody>
            </v-table>
          </v-card-text>
        </v-card>
      </template>
    </PanelState>
  </div>
</template>
