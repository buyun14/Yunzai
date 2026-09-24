<script setup lang="ts">
import { computed, ref } from "vue"
import { getPlugins } from "@/api/client"
import type { LoadedPlugin } from "@/api/types"
import PanelState from "@/components/PanelState.vue"
import { useAsync } from "@/composables/useAsync"

/**
 * 插件列表。
 *
 * # 两条来自后端的硬约束，界面必须照做
 *
 * 1. **顺序不许重排**。数组顺序就是**执行顺序**（按 `priority` 升序），
 *    那是排查「为什么这个插件先抢到消息」的第一手材料；
 *    界面自己再排一次（比如按名字）会把这个信息弄丢。
 *    所以序号列放在第一列，且没有「排序」交互。
 * 2. **`priority` 可能是 `null`**，表示插件没声明，实际顺序由数组下标表达。
 *    显示成空或 `0` 都是错的（`0` 会被误读成一个真实的优先级），
 *    这里显式写成「未声明」。
 */
const { data, error, loading, refresh } = useAsync(getPlugins)

const keyword = ref("")

const plugins = computed(() => data.value?.plugins ?? [])

/** 展开的行（`key` 可能重复——同一文件可注册多个插件类，所以用下标当键） */
const expanded = ref<number[]>([])

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
              </tr>

              <!-- 展开的规则明细：正则原样显示（它就是匹配依据），不做美化 -->
              <tr v-if="expanded.includes(row.index)">
                <td />
                <td colspan="5" class="pa-0">
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
