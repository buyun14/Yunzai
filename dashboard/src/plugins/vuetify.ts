import { createVuetify, type IconSet } from "vuetify"
import { h, type FunctionalComponent } from "vue"
import {
  mdiAccountMultipleOutline,
  mdiAlertCircleOutline,
  mdiArrowDown,
  mdiArrowLeft,
  mdiArrowRight,
  mdiArrowUp,
  mdiBroom,
  mdiChartArc,
  mdiChartDonut,
  mdiCheck,
  mdiCheckboxMarked,
  mdiChevronDown,
  mdiChevronLeft,
  mdiChevronRight,
  mdiChevronUp,
  mdiCircle,
  mdiClose,
  mdiCloseCircle,
  mdiCogOutline,
  mdiCollapseAll,
  mdiConnection,
  mdiContentSave,
  mdiDelete,
  mdiExpandAll,
  mdiEye,
  mdiEyeOff,
  mdiFileCogOutline,
  mdiFileDocumentMultipleOutline,
  mdiInformationOutline,
  mdiKeyAlert,
  mdiKeyVariant,
  mdiLanConnect,
  mdiMagnify,
  mdiMemory,
  mdiMenu,
  mdiMenuDown,
  mdiMenuLeft,
  mdiMenuRight,
  mdiMenuUp,
  mdiMinus,
  mdiMinusBox,
  mdiPause,
  mdiPencil,
  mdiPlay,
  mdiPlus,
  mdiPlusBox,
  mdiPuzzleOutline,
  mdiRefresh,
  mdiSpeedometer,
  mdiTagOutline,
  mdiTextBoxSearchOutline,
  mdiTimerOutline,
  mdiUnfoldMoreHorizontal,
  mdiUnfoldMoreVertical,
  mdiWindowClose,
  mdiWindowMinimize,
  mdiWindowRestore,
} from "@mdi/js"
import "vuetify/styles"

/**
 * Vuetify 3 实例。
 *
 * # 图标为什么走 `@mdi/js` 的 SVG 路径，而不是 `@mdi/font` 的网络字体
 *
 * 两者都是 MDI，但代价差一个数量级。`@mdi/font` 是一份**完整**字体：
 * 实测 woff2 403KB + woff 588KB + ttf/eot 各 1.28MB ≈ **3.4MB，而且全都会被打进产物**
 * ——Vuetify 的 `mdi` 图标集用 CSS 类名取字形，bundler 判断不出哪些字形被用到。
 * `@mdi/js` 按路径导出，只有显式 import 的才进产物（面板一共五十来个图标）。
 *
 * 代价：**新增图标要在下面的 `iconPaths` 里补一行**。漏了的表现是那个位置空着
 * （Vuetify 会打一句 `Could not find aliased icon`），不会报错。
 *
 * # 名字是怎么落地的（这里有个 Vuetify 的坑）
 *
 * `IconSet` 类型**只有 `component` 一个字段**，没有官网上那种 `icon()` 映射函数
 * （实测 `lib/composables/icons.d.ts`）。`useIcon` 会把 `mdi-speedometer` 原样交给
 * 图标集的 component，所以「名字 → 路径」这一步只能做在 `aliases` 里：
 * 把 `iconPaths` 整张表摊成 `mdi-<名字> → SVG 路径` 的别名。
 * 组件因此只需要画一个 `<svg>`。
 */

/**
 * 面板用到的图标：`mdi-xxx`（模板里写的字符串）→ `@mdi/js` 的 SVG 路径。
 *
 * 这张表就是 tree-shaking 的边界：它 import 了哪些，产物里就只有哪些。
 */
const iconPaths: Record<string, string> = {
  // App.vue / AuthDialog.vue
  "account-multiple-outline": mdiAccountMultipleOutline,
  "alert-circle-outline": mdiAlertCircleOutline,
  "arrow-down": mdiArrowDown,
  "arrow-left": mdiArrowLeft,
  "arrow-right": mdiArrowRight,
  "arrow-up": mdiArrowUp,
  broom: mdiBroom,
  "checkbox-marked": mdiCheckboxMarked,
  check: mdiCheck,
  "chevron-up": mdiChevronUp,
  "chevron-left": mdiChevronLeft,
  circle: mdiCircle,
  close: mdiClose,
  "close-circle": mdiCloseCircle,
  delete: mdiDelete,
  "cog-outline": mdiCogOutline,
  eye: mdiEye,
  "eye-off": mdiEyeOff,
  "information-outline": mdiInformationOutline,
  "key-alert": mdiKeyAlert,
  "key-check": mdiKeyVariant,
  // router/index.ts 的导航图标
  "file-cog-outline": mdiFileCogOutline,
  "puzzle-outline": mdiPuzzleOutline,
  speedometer: mdiSpeedometer,
  "text-box-search-outline": mdiTextBoxSearchOutline,
  // 各页面模板里直接写着的
  "chart-arc": mdiChartArc,
  "chart-donut": mdiChartDonut,
  "chevron-down": mdiChevronDown,
  "chevron-right": mdiChevronRight,
  "collapse-all": mdiCollapseAll,
  connection: mdiConnection,
  "expand-all": mdiExpandAll,
  "file-document-multiple-outline": mdiFileDocumentMultipleOutline,
  "lan-connect": mdiLanConnect,
  magnify: mdiMagnify,
  memory: mdiMemory,
  menu: mdiMenu,
  minus: mdiMinus,
  pencil: mdiPencil,
  plus: mdiPlus,
  refresh: mdiRefresh,
  "tag-outline": mdiTagOutline,
  "timer-outline": mdiTimerOutline,
  // Vuetify 部分控件会按 mdi- 名字直接引用的
  "window-close": mdiWindowClose,
  "window-minimize": mdiWindowMinimize,
  "window-restore": mdiWindowRestore,
  "menu-down": mdiMenuDown,
  "menu-left": mdiMenuLeft,
  "menu-right": mdiMenuRight,
  "menu-up": mdiMenuUp,
  "plus-box": mdiPlusBox,
  "minus-box": mdiMinusBox,
  pause: mdiPause,
  play: mdiPlay,
  save: mdiContentSave,
  "unfold-more-horizontal": mdiUnfoldMoreHorizontal,
  "unfold-more-vertical": mdiUnfoldMoreVertical,
}

/**
 * Vuetify 控件内部引用的图标别名（`$close` / `$expand` / `$sortAsc` 这类）。
 *
 * 必须显式给出：控件的默认图标就是这些别名，而 SVG 图标集没有可回落的字体，
 * 缺一个就少一个图标（控制台同时会刷 `Could not find aliased icon`）。
 */
const controlAliases: Record<string, string> = {
  complete: "mdi-check",
  cancel: "mdi-close-circle",
  close: "mdi-close",
  delete: "mdi-delete",
  clear: "mdi-close",
  success: "mdi-checkbox-marked",
  info: "mdi-information-outline",
  warning: "mdi-alert-circle-outline",
  error: "mdi-close-circle",
  prev: "mdi-chevron-left",
  next: "mdi-chevron-right",
  checkboxOn: "mdi-checkbox-marked",
  checkboxOff: "mdi-close-circle",
  checkboxIndeterminate: "mdi-minus-box",
  delimiter: "mdi-circle",
  sortAsc: "mdi-arrow-up",
  sortDesc: "mdi-arrow-down",
  expand: "mdi-chevron-down",
  menu: "mdi-menu",
  subgroup: "mdi-menu-down",
  dropdown: "mdi-menu-down",
  radioOn: "mdi-circle",
  radioOff: "mdi-circle",
  edit: "mdi-pencil",
  ratingEmpty: "mdi-circle",
  ratingFull: "mdi-circle",
  ratingHalf: "mdi-circle",
  loading: "mdi-refresh",
  first: "mdi-chevron-left",
  last: "mdi-chevron-right",
  unfold: "mdi-unfold-more-horizontal",
  file: "mdi-file-document-multiple-outline",
  plus: "mdi-plus",
  minus: "mdi-minus",
  calendar: "mdi-timer-outline",
  treeviewCollapse: "mdi-collapse-all",
  treeviewExpand: "mdi-expand-all",
  eyeDropper: "mdi-eye",
  upload: "mdi-arrow-up",
  color: "mdi-circle",
  command: "mdi-cog-outline",
  ctrl: "mdi-chevron-up",
  space: "mdi-arrow-right",
  shift: "mdi-arrow-up",
  alt: "mdi-cog-outline",
  enter: "mdi-arrow-left",
  arrowUp: "mdi-arrow-up",
  arrowDown: "mdi-arrow-down",
  arrowLeft: "mdi-arrow-left",
  arrowRight: "mdi-arrow-right",
}

/**
 * 最终别名表：`mdi-<名字>` → SVG 路径，再叠上控件别名。
 *
 * `mdi-` 前缀不能省——模板里写的是 `mdi-speedometer`，`useIcon` 是拿这个字符串
 * 去 `aliases` 里直接查的，查不到才会按 `set:name` 的前缀规则找图标集。
 */
const aliases: Record<string, string> = {
  ...Object.fromEntries(Object.entries(iconPaths).map(([name, path]) => [`mdi-${name}`, path])),
  ...controlAliases,
}

/**
 * 一个最小 SVG 图标组件。
 *
 * **为什么自己写**：Vuetify 3.13 不对外导出渲染用的 `VSvgIcon` / `VClassIcon`
 * （实测 `Object.keys(import("vuetify"))` 里一个都不含 "icon"），引用它们要么报
 * TS2305、要么得去 import 内部路径——那是拿版本稳定性换的便宜。
 *
 * # `props.icon` 拿到的是**名字**，不是路径（踩过一次）
 *
 * 曾经以为 `useIcon` 会先用 `aliases` 把名字解析掉、组件收到路径。
 * 用 puppeteer 打出真实值才发现不是：组件收到的就是 `"mdi-menu"`、`"mdi-key-check"`
 * 这样的**原始名字**（Vuetify 3.13 的 `useIcon` 只做别名一层，
 * 按前缀找图标集这一步之后，名字是**原样**交给 component 的）。
 *
 * 所以"名字 → 路径"只有两个可行位置：`aliases`（但 `aliases` 的值会被当名字再解析，
 * 不能放路径），或者**这里**。这里就是它的位置。
 *
 * 后果曾经很严重：查不到就返回 null，而 Vuetify 会退回 `VClassIcon` 渲染
 * `<i class="mdi-menu">`——没有图标字体的话浏览器解析 `<path d="mdi-menu">`
 * 失败、控制台刷 `Expected number, "mdi-menu"`，**整个面板一个图标都没有**。
 *
 * 类型上退一步：`IconProps` 的 `tag` 是 `string | JSXComponent`，而 `JSXComponent`
 * 来自 Vuetify 的内部路径（同样不在导出面上）。为了不为此引内部类型，
 * 这里把组件声明成宽松签名、在赋给 `IconSet` 时收口——运行期契约是一致的。
 */
const MdiSvgIcon: FunctionalComponent<{ icon?: unknown; tag?: string }> = props => {
  const value = props.icon
  if (typeof value !== "string" && !Array.isArray(value)) return null

  // 名字 → 路径。数组（多色图标）原样用，单个字符串按 `mdi-<名字>` 查表；
  // 查不到就直接返回 null（画不出来好过画出一个浏览器解析不了的 path）
  let paths: Array<string | [string, number]>
  if (Array.isArray(value)) {
    paths = value as Array<string | [string, number]>
  } else {
    const path = iconPaths[value.replace(/^mdi-/, "")]
    if (!path) return null
    paths = [path]
  }

  return h(props.tag ?? "i", { class: "v-icon__svg" }, [
    h(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: "0 0 24 24",
        role: "img",
        "aria-hidden": "true",
      },
      paths.map((path, i) =>
        h(
          "path",
          Array.isArray(path)
            ? { key: i, d: path[0], "fill-opacity": path[1] }
            : { key: i, d: path },
        ),
      ),
    ),
  ])
}

const mdiSvgSet = { component: MdiSvgIcon } as unknown as IconSet

export default createVuetify({
  icons: {
    defaultSet: "mdi",
    aliases,
    sets: { mdi: mdiSvgSet },
  },
  theme: {
    defaultTheme: "light",
  },
})
