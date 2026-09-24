<script setup lang="ts">
import { computed, ref } from "vue"
import { useRoute } from "vue-router"
import AuthDialog from "@/components/AuthDialog.vue"
import { routes } from "@/router"
import { useAuthStore } from "@/stores/auth"

/**
 * 应用外壳：应用栏 + 侧边导航 + 一个鉴权设置对话框。
 *
 * 导航项直接从路由表生成（`meta.title` / `meta.icon`），不另外维护一份列表——
 * 两份列表必然会在加页面时漂移。
 */
const auth = useAuthStore()
const route = useRoute()
const drawer = ref(true)

const navItems = computed(() =>
  routes
    .filter(item => item.meta?.title)
    .map(item => ({
      to: item.path,
      title: String(item.meta?.title ?? ""),
      icon: String(item.meta?.icon ?? "mdi-circle-small"),
    })),
)

const currentTitle = computed(() => String(route.meta?.title ?? "运维面板"))
</script>

<template>
  <v-app>
    <v-app-bar color="primary" density="comfortable" flat>
      <v-app-bar-nav-icon
        :aria-label="drawer ? '收起导航' : '展开导航'"
        @click="drawer = !drawer"
      />
      <v-app-bar-title>Yunzai 运维面板</v-app-bar-title>
      <v-spacer />
      <v-chip class="mr-2" variant="flat" color="surface" size="small">
        {{ currentTitle }}
      </v-chip>
      <!-- 令牌状态一直显示：面板最常见的失败是「忘了填令牌」，
           而不是后端坏了，所以这个入口必须显眼、且能看出当前有没有填。 -->
      <v-btn
        :prepend-icon="auth.hasToken ? 'mdi-key-check' : 'mdi-key-alert'"
        :color="auth.hasToken ? undefined : 'warning'"
        variant="text"
        @click="auth.dialog = true"
      >
        {{ auth.hasToken ? "已配置令牌" : "未配置令牌" }}
      </v-btn>
    </v-app-bar>

    <v-navigation-drawer v-model="drawer" :width="220">
      <v-list density="comfortable" nav>
        <v-list-item
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="item.title"
          exact
        />
      </v-list>
      <template #append>
        <v-list density="compact" class="text-caption text-medium-emphasis">
          <v-list-item
            title="v1 只读面板"
            subtitle="配置编辑与插件启停在 v2/v3"
            prepend-icon="mdi-information-outline"
          />
        </v-list>
      </template>
    </v-navigation-drawer>

    <v-main>
      <v-container fluid class="pa-4">
        <router-view />
      </v-container>
    </v-main>

    <AuthDialog />
  </v-app>
</template>
