import { createApp } from "vue"
import App from "@/App.vue"
import vuetify from "@/plugins/vuetify"
import router from "@/router"
import pinia from "@/stores"

/**
 * 面板入口。
 *
 * 挂载顺序无关紧要，但有两点是刻意的：
 *
 * 1. **没有用 `Vue.use(...)` 那套**——Vue 3 的插件一律通过 `app.use()` 装，
 *    只装这三个（pinia / router / vuetify）。
 * 2. **没有全局错误边界**。后端连不上是**正常状态**（面板启用但宿主还在启动），
 *    各页面自己处理失败并给出可照做的提示，而不是让整个应用白屏。
 */
createApp(App).use(pinia).use(router).use(vuetify).mount("#app")
