<script setup lang="ts">
import { computed, ref } from "vue"
import { ApiError, getPlugins, putPlugin } from "@/api/client"
import type { LoadedPlugin } from "@/api/types"
import PanelState from "@/components/PanelState.vue"
import { useAsync } from "@/composables/useAsync"
import { useAuthStore } from "@/stores/auth"

/**
 * 插件列表 + 启停。
 *
 * # 三条来自后端的硬约束，界面必须照做
 *
 * 1. **顺序不许重排**。数组顺序就是**执行顺序**（按 `priority` 升序），
 *    那是排查「为什么这个插件先抢到消息」的第一手材料；
 *    界面自己再排一次（比如按名字）会把这个信息弄丢。
 *    所以序号列放在第一列，且没有「排序」交互。
 * 2. **`priority` 可能是 `null`**，表示插件没声明，实际顺序由数组下标表达。
 *    显示成空或 `0` 都是错的（`0` 会被误读成一个真实的优先级），
 *    这里显式写成「未声明」。
 * 3. **停用是按插件名匹配全局名单的**（`group.yaml` 的 `default.disable`）。
 *    所以 `name` 为 `null` 的条目**无法启停**——开关要禁用并说明原因，
 *    而不是让用户点了没反应。
 */
const auth = useAuthStore()

const { data, error, loading, refresh } = useAsync(getPlugins)

const keyword = ref("")

const plugins = computed(() => data.value?.plugins ?? [])

/** 展开的行（`key` 可能重复——同一文件可注册多个插件类，所以用下标当键） */
const expanded = ref<number[]>([])

/** 正在切换的插件名 */
const toggling = ref("")
const toggleError = ref("")
/** 上一次切换的结果（含后端给的那句边界说明） */
const toggleNotice = ref("")

/**
 * 切换一个插件的启停。
 *
 * 成功后**只刷新列表**，不乐观更新本地状态：`enabled` 是"在不在全局停用名单里"，
 * 而名单可能因为别的群段配置与预期不同——以服务端的回答为准。
 *
 * @param plugin 插件条目
 * @returns 无
 */
async function toggleEnabled(plugin: LoadedPlugin): Promise<void> {
  if (!plugin.name || plugin.enabled === null) return
  toggling.value = plugin.name
  toggleError.value = ""
  toggleNotice.value = ""
  try {
    const result = await putPlugin(plugin.name, !plugin.enabled)
    // 后端会如实说明"更具体的群段可以盖过这条"，那句比我们自己编一句更准
    toggleNotice.value = `${result.name} 已${result.enabled ? "启用" : "停用"}。${result.note}`
    await refresh()
  } catch (err) {
    if (err instanceof ApiError && err.isUnauthorized) auth.promptForToken()
    toggleError.value = err instanceof Error ? err.message : String(err)
  } finally {
    toggling.value = ""
  }
}

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  // 保留原始下标：它既是执行顺序，也是展开状态的键
  const rows = plugins.value.map((plugin, index) => ({ plugin, index }))
  if (!kw) return rows
  return rows.filter(({ plugin }) =>
    [plugin.name, plugin.key, plugin.namespace, plugin.description]
      .filter(Boolean)
      .some(field => String(field).toLowerCase().includes(kw)),
  )
})

function toggle(index: number): void {
  const at = expanded.value.indexOf(index)
  if (at === -1) expanded.value = [...expanded.value, index]
  else expanded.value = expanded.value.filter(i => i !== index)
}

/** 显示名：`name` 为空时退回类标识，最后才显示占位——空单元格在表里最难读 */
function displayName(plugin: LoadedPlugin): string {
  return plugin.name || plugin.key || "（未命名）"
}
</script>

<template>
  <div>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-h6">插件列表</h2>
      <v-chip v-if="data" size="small" variant="tonal">共 {{ data.total }} 条调度条目</v-chip>
      <v-spacer />
      <v-text-field
        v-model="keyword"
        placeholder="按名称 / 标识 / 命名空间筛选"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        variant="outlined"
        hide-details
        clearable
        style="max-width: 320px"
      />
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
      顺序就是<strong>执行顺序</strong>（按 <code>priority</code> 升序），界面不做重排；
      数据来自内存里已排好序的加载结果，不是磁盘上的 <code>plugin.json</code>。
      <br />
      启停写的是 <code>config/config/group.yaml</code> 的 <code>default.disable</code> 名单，按
      <strong>插件名</strong> 匹配，<strong>写完立刻生效</strong>（不需要重启）。
      注意：单独给某个群配了 <code>enable</code> 的会盖过这里的全局停用。
    </v-alert>

    <v-alert v-if="toggleError" type="error" variant="tonal" density="comfortable" class="mb-4">
      {{ toggleError }}
    </v-alert>
    <v-alert
      v-if="toggleNotice"
      type="success"
      variant="tonal"
      density="comfortable"
      class="mb-4"
      data-testid="plugin-toggle-notice"
    >
      {{ toggleNotice }}
    </v-alert>

    <PanelState
      :loading="loading"
      :error="error"
      :empty="!plugins.length"
      empty-text="没有已加载的插件"
      :on-retry="refresh"
    >
      <v-card variant="outlined">
        <v-table density="comfortable" hover>
          <thead>
            <tr>
              <th style="width: 64px">#</th>
              <th>插件</th>
              <th style="width: 160px">命名空间</th>
              <th style="width: 90px">priority</th>
              <th style="width: 120px">事件</th>
              <th style="width: 90px">规则</th>
              <th style="width: 90px">启用</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in filtered" :key="row.index">
              <tr
                :class="{ 'cursor-pointer': row.plugin.rules.length }"
                @click="row.plugin.rules.length && toggle(row.index)"
              >
                <td class="text-medium-emphasis">{{ row.index + 1 }}</td>
                <td>
                  <div class="d-flex align-center ga-1">
                    <v-icon
                      v-if="row.plugin.rules.length"
                      size="small"
                      :icon="
                        expanded.includes(row.index) ? 'mdi-chevron-down' : 'mdi-chevron-right'
                      "
                    />
                    <span v-else class="d-inline-block" style="width: 20px" />
                    <div>
                      <div>{{ displayName(row.plugin) }}</div>
                      <div v-if="row.plugin.key" class="text-caption text-medium-emphasis">
                        {{ row.plugin.key }}
                      </div>
                      <div v-if="row.plugin.description" class="text-caption">
                        {{ row.plugin.description }}
                      </div>
                    </div>
                  </div>
                </td>
                <td class="text-caption">{{ row.plugin.namespace || "—" }}</td>
                <td>
                  <span v-if="row.plugin.priority === null" class="text-medium-emphasis">
                    未声明
                  </span>
                  <span v-else>{{ row.plugin.priority }}</span>
                </td>
                <td>
                  <v-chip
                    v-for="event in row.plugin.events"
                    :key="event"
                    size="x-small"
                    variant="tonal"
                    class="ma-1"
                  >
                    {{ event }}
                  </v-chip>
                  <span v-if="!row.plugin.events.length" class="text-medium-emphasis">—</span>
                </td>
                <td>{{ row.plugin.rules.length }}</td>
                <td @click.stop>
                  <!-- 没有名字的条目无法按名字启停：禁用开关并说明，而不是点了没反应 -->
                  <v-tooltip
                    :text="
                      row.plugin.enabled === null
                        ? '这个条目没有名字，无法用启停接口表达'
                        : row.plugin.enabled
                          ? '点击停用'
                          : '点击启用'
                    "
                    location="top"
                  >
                    <template #activator="{ props: tip }">
                      <v-switch
                        v-bind="tip"
                        :data-testid="`plugin-toggle-${row.index}`"
                        :model-value="row.plugin.enabled === true"
                        :disabled="row.plugin.enabled === null"
                        :loading="toggling === row.plugin.name"
                        color="primary"
                        density="compact"
                        hide-details
                        @update:model-value="toggleEnabled(row.plugin)"
                      />
                    </template>
                  </v-tooltip>
                </td>
              </tr>

              <!-- 展开的规则明细：正则原样显示（它就是匹配依据），不做美化 -->
              <tr v-if="expanded.includes(row.index)">
                <td />
                <td colspan="6" class="pa-0">
                  <v-table density="compact" class="bg-surface-light">
                    <thead>
                      <tr>
                        <th style="width: 45%">正则</th>
                        <th style="width: 20%">处理方法</th>
                        <th style="width: 20%">权限</th>
                        <th style="width: 15%">日志</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(rule, ri) in row.plugin.rules" :key="ri">
                        <td class="text-caption font-weight-mono">{{ rule.reg }}</td>
                        <td class="text-caption">{{ rule.fnc || "—" }}</td>
                        <td class="text-caption">{{ rule.permission || "—" }}</td>
                        <td class="text-caption">
                          <span v-if="rule.log === false">降级为 debug</span>
                          <span v-else-if="rule.log === true">记录</span>
                          <span v-else class="text-medium-emphasis">未声明</span>
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                </td>
              </tr>
            </template>
          </tbody>
        </v-table>
        <v-card-text v-if="!filtered.length && plugins.length" class="text-medium-emphasis">
          没有匹配「{{ keyword }}」的插件。
        </v-card-text>
      </v-card>
    </PanelState>
  </div>
</template>

<style scoped>
.font-weight-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
