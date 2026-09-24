<script setup lang="ts">
/**
 * 统一的「加载 / 出错 / 空」三态外壳。
 *
 * 四页共用：不这么做的话，每一页都会自己写一遍，
 * 而漏掉「出错时把 loading 关掉」是最常见的疏漏（表现为永远转圈）。
 */
defineProps<{
  loading: boolean
  error: string
  /** 取数成功但没有内容（与「出错」是两回事，提示不一样） */
  empty?: boolean
  emptyText?: string
  /** 出错时的重试入口；不给就只显示错误 */
  onRetry?: () => void
}>()
</script>

<template>
  <div>
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4" :title="error">
      <template #append>
        <v-btn
          v-if="onRetry"
          variant="text"
          size="small"
          prepend-icon="mdi-refresh"
          @click="onRetry()"
        >
          重试
        </v-btn>
      </template>
    </v-alert>

    <div v-if="loading && !error" class="d-flex justify-center pa-8">
      <v-progress-circular indeterminate color="primary" />
    </div>

    <v-alert v-else-if="empty" type="info" variant="tonal">
      {{ emptyText || "没有数据" }}
    </v-alert>

    <slot v-else />
  </div>
</template>
