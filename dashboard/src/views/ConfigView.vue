<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { ApiError, getConfigFile, getConfigList } from "@/api/client"
import type { ConfigFile, ConfigFileStatus } from "@/api/types"
import ConfigValue from "@/components/ConfigValue.vue"
import PanelState from "@/components/PanelState.vue"
import { useAsync } from "@/composables/useAsync"
import { useAuthStore } from "@/stores/auth"

/**
 * 配置查看（只读）。
 *
 * # 三条来自后端的硬约束
 *
 * 1. **文件名只能来自清单**。`/config/{name}` 的白名单是 `^[\w.-]+\.ya?ml$`
 *    且要求 `basename` 等于原名（`lib/web/api/config.js`），所以界面**不给**输入框，
 *    只让点清单里的项——自己拼路径只会拿到 400。
 * 2. **脱敏必须说明**。后端把密钥键整值换成 `***` 并在 `redacted` 里列出路径；
 *    界面必须在页面上说清「部分密钥未展示」，否则用的人会以为配置本身就是 `***`。
 *    具体位置由 `ConfigValue` 就地标注。
 * 3. **清单里的文件不等于有差异的文件**。后端自己列目录（而不是直接用
 *    `collectDiff()` 的差异清单），所以一份与默认完全一致的文件也必须在清单里
 *    ——否则它会凭空消失。
 *
 * 这一页是**只读**的：写配置要走 v2 的 schema 表单与同构校验器（分册 §3.5）。
 */
const auth = useAuthStore()

const { data, error, loading, refresh } = useAsync(getConfigList)

const selected = ref("")
const file = ref<ConfigFile | null>(null)
const fileError = ref("")
const fileLoading = ref(false)
/** 看用户侧还是出厂默认侧 */
const side = ref<"user" | "defaults">("user")

// 清单到手的默认选中：第一个文件。不自动选的话右侧永远空着，看不出这页能干什么。
watch(data, list => {
  if (!list?.files.length || selected.value) return
  selected.value = list.files[0].name
})

watch(selected, async name => {
  fileError.value = ""
  file.value = null
  if (!name) return

  fileLoading.value = true
  try {
    file.value = await getConfigFile(name)
    // 只有一侧有值时直接切到有值的那侧，免得看到一个空的 `null`
    side.value = file.value.user === null && file.value.defaults !== null ? "defaults" : "user"
  } catch (err) {
    if (err instanceof ApiError) {
      fileError.value = err.message
      if (err.isUnauthorized) auth.promptForToken()
    } else {
      fileError.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    fileLoading.value = false
  }
})

const STATUS_LABEL: Record<ConfigFileStatus, string> = {
  both: "两侧都有",
  "only-user": "仅用户侧",
  "only-default": "仅默认侧",
}

const STATUS_COLOR: Record<ConfigFileStatus, string> = {
  both: "success",
  "only-user": "warning",
  "only-default": "info",
}

function statusColor(status: ConfigFileStatus): string {
  return STATUS_COLOR[status] ?? "grey"
}

function statusLabel(status: ConfigFileStatus): string {
  return STATUS_LABEL[status] ?? status
}

/** 一个文件与默认的差异总数——用来决定要不要给这个文件一个醒目的标记 */
function diffCount(entry: {
  differences: { missing: number; extra: number; changed: number }
}): number {
  const d = entry.differences
  return d.missing + d.extra + d.changed
}

const currentSideLabel = computed(() =>
  side.value === "user" ? "用户配置（config/config）" : "出厂默认（config/default_config）",
)

const currentSideValue = computed(() => {
  if (!file.value) return undefined
  return side.value === "user" ? file.value.user : file.value.defaults
})
</script>

<template>
  <div>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-h6">配置查看</h2>
      <v-chip v-if="data" size="small" variant="tonal">{{ data.files.length }} 个文件</v-chip>
      <v-spacer />
      <v-btn
        prepend-icon="mdi-refresh"
        variant="tonal"
        size="small"
        :loading="loading"
        @click="refresh()"
      >
        刷新
      </v-btn>
    </div>

    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      只读查看。写入要走 v2 的 schema 表单与同构校验器（见
      <code>06-webui.md</code>
      §3.5）。密钥键（<code>pass</code>/<code>secret</code>/<code>token</code>/<code>auth</code>/<code>credential</code>/<code>cookie</code>）
      的值由后端脱敏成 <code>***</code>，被遮的位置在下方就地标出。
    </v-alert>

    <PanelState
      :loading="loading"
      :error="error"
      :empty="!data?.files.length"
      empty-text="没有找到任何 yaml 配置文件"
      :on-retry="refresh"
    >
      <v-row v-if="data">
        <v-col cols="12" md="4" lg="3">
          <v-card variant="outlined">
            <v-card-item title="文件" prepend-icon="mdi-file-document-multiple-outline" />
            <v-divider />
            <v-list density="compact" nav>
              <v-list-item
                v-for="entry in data.files"
                :key="entry.name"
                :active="selected === entry.name"
                @click="selected = entry.name"
              >
                <v-list-item-title>{{ entry.name }}</v-list-item-title>
                <v-list-item-subtitle>
                  <v-chip
                    :color="statusColor(entry.status)"
                    size="x-small"
                    variant="tonal"
                    class="mr-1"
                  >
                    {{ statusLabel(entry.status) }}
                  </v-chip>
                  <span v-if="diffCount(entry)" class="text-caption">
                    差异 {{ diffCount(entry) }}
                  </span>
                  <span v-else class="text-caption text-medium-emphasis">与默认一致</span>
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <v-divider />
            <v-card-text class="text-caption text-medium-emphasis">
              <div>用户目录：<br />{{ data.dirs.config }}</div>
              <div class="mt-1">默认目录：<br />{{ data.dirs.defaults }}</div>
            </v-card-text>
          </v-card>
        </v-col>

        <v-col cols="12" md="8" lg="9">
          <v-card variant="outlined" min-height="300">
            <v-card-item>
              <template #title>
                <span class="text-body-1">{{ selected || "未选择文件" }}</span>
              </template>
              <template #append>
                <v-btn-toggle v-model="side" density="compact" variant="outlined" divided mandatory>
                  <v-btn value="user" size="small">用户侧</v-btn>
                  <v-btn value="defaults" size="small">默认侧</v-btn>
                </v-btn-toggle>
              </template>
            </v-card-item>
            <v-divider />

            <div v-if="fileLoading" class="d-flex justify-center pa-8">
              <v-progress-circular indeterminate color="primary" />
            </div>

            <v-alert v-else-if="fileError" type="error" variant="tonal" class="ma-4">
              {{ fileError }}
            </v-alert>

            <template v-else-if="file">
              <v-alert
                v-if="file.redacted.length"
                type="warning"
                variant="tonal"
                density="comfortable"
                class="ma-4 mb-0"
              >
                有 {{ file.redacted.length }} 处密钥未展示（由后端脱敏）：
                <code>{{ file.redacted.join("、") }}</code>
              </v-alert>

              <v-card-subtitle class="pt-4">{{ currentSideLabel }}</v-card-subtitle>
              <v-card-text>
                <div v-if="currentSideValue === null" class="text-medium-emphasis">
                  这个文件在{{ side === "user" ? "用户侧" : "默认侧" }}不存在（值为 null）。
                </div>
                <ConfigValue v-else :value="currentSideValue" :redacted="file.redacted" path="" />
              </v-card-text>
            </template>

            <v-card-text v-else class="text-medium-emphasis"> 从左侧选一个文件。 </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </PanelState>
  </div>
</template>
