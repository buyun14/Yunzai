import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router"

/**
 * 四个页面（`06-webui.md` §7.1）。
 *
 * 其中三个是只读的（状态总览 / 插件列表 / 实时日志），**配置页可写**——
 * 它有查看与编辑两种模式（v2，见 `ConfigView.vue` 与 BCR-0004）。
 *
 * # 为什么是 hash 路由
 *
 * 面板挂在 `/dashboard` 前缀下，而宿主的 express **没有**给这个前缀注册
 * 「未命中就回 index.html」的兜底（也不该注册：那会吃掉适配器自己的路径）。
 * history 模式下刷新 `/dashboard/plugins` 会直接 404，hash 模式则永远只请求
 * `/dashboard/` 这一个入口——不需要后端配合，也不需要 base 路径参与解析。
 *
 * 代价是地址里多个 `#`，对运维面板来说无所谓。
 */
export const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/status" },
  {
    path: "/status",
    name: "status",
    component: () => import("@/views/StatusView.vue"),
    meta: { title: "状态总览", icon: "mdi-speedometer" },
  },
  {
    path: "/plugins",
    name: "plugins",
    component: () => import("@/views/PluginsView.vue"),
    meta: { title: "插件列表", icon: "mdi-puzzle-outline" },
  },
  {
    path: "/config",
    name: "config",
    component: () => import("@/views/ConfigView.vue"),
    meta: { title: "配置查看", icon: "mdi-file-cog-outline" },
  },
  {
    path: "/logs",
    name: "logs",
    component: () => import("@/views/LogsView.vue"),
    meta: { title: "实时日志", icon: "mdi-text-box-search-outline" },
  },
  // 未知路径回到状态页，而不是留一个空白屏
  { path: "/:pathMatch(.*)*", redirect: "/status" },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
})
