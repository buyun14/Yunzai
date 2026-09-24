/// <reference types="vite/client" />

/**
 * `.vue` 单文件组件的模块声明。
 *
 * 有它在，`vue-tsc` 才能对 `import X from "./X.vue"` 求解类型；
 * 缺了它每一处组件导入都会报 TS2307。
 */
declare module "*.vue" {
  import type { DefineComponent } from "vue"

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
