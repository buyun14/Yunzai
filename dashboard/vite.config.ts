import { fileURLToPath, URL } from "node:url"
import vue from "@vitejs/plugin-vue"
import vuetify from "vite-plugin-vuetify"
import { defineConfig } from "vite"

/**
 * 面板的前端工程。
 *
 * 两个刻意的决定：
 *
 * 1. **`base: "/dashboard/"`**。产物要挂在宿主的 `/dashboard` 前缀下
 *    （`lib/web/server.js` 的 `UI_PREFIX`），保持默认的 `/` 会让所有
 *    `assets/*.js` 请求打到根路径——那正好是适配器路由与 `/File` 的地盘。
 *
 * 2. **由 vite 预编译 Vuetify**（`vite-plugin-vuetify` 的 `autoImport`）而不是
 *    手写 `vuetify.ts` 的全量组件注册：按需引入能把产物控制在几百 KB，
 *    而面板是给运维用的，加载速度直接影响体验。
 */
export default defineConfig({
  base: "/dashboard/",
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  /**
   * 联调用的代理。
   *
   * 后端**默认要求鉴权头**（`server.auth`，键名即头名），且没有开 CORS。
   * 令牌存在浏览器的 localStorage 里、由前端代码显式加在请求上，
   * 所以这里只需要把 `/api` 转发到宿主，**不在这里注入令牌**——
   * 令牌一旦写进 vite 配置就等于进了仓库与访问日志。
   *
   * SSE（`/api/v1/logs`）必须关掉响应缓冲，否则「连上了但一条都看不到」。
   * 后端已经带了 `Cache-Control: no-transform`（防宿主的 `compression()`），
   * 代理这一层再显式声明一次，免得以后换了代理实现就静默失效。
   */
  server: {
    port: 5273,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:2536",
        changeOrigin: true,
        // http-proxy 的缓冲开关：对 SSE 必须关
        configure(proxy) {
          proxy.on("proxyRes", proxyRes => {
            if (String(proxyRes.headers["content-type"] ?? "").includes("text/event-stream"))
              proxyRes.headers["cache-control"] = "no-cache, no-transform"
          })
        },
      },
    },
  },
  build: {
    outDir: "dist",
    // 产物由宿主静态托管，不需要 sourcemap 进分发
    sourcemap: false,
  },
})
