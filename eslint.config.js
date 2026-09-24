import js from "@eslint/js"
import globals from "globals"

/**
 * 由 app.js 与 lib/config/*.js 注入的全局变量，插件与内核中大量裸用。
 * 见 docs/refactor/99-compat-and-migration.md 的 L0 冻结层。
 */
const injectedGlobals = {
  Bot: "readonly",
  logger: "readonly",
  redis: "readonly",
  plugin: "readonly",
  segment: "readonly",
  Renderer: "readonly",
  start_type: "writable",
}

export default [
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "resources/**",
      "renderers/**",
      "lib/modules/**",
      "plugins/miao-plugin/**",
      "logs/**",
      "data/**",
      "temp/**",
      "coverage/**",
      // 面板前端的构建产物：压缩过的 bundle，报出来的都是
      // "window is not defined" 这类对生成代码无意义的规则命中
      // （`.prettierignore` 里同样忽略它）
      "dashboard/dist/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...injectedGlobals },
    },
    rules: {
      // 允许未使用的函数参数（回调签名常需要），但不允许未使用的变量
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      // allowEmptyCatch：项目中有大量 `catch {}` 的刻意忽略用法
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // `while (true)` 是本项目的常见模式
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      // .puppeteerrc.cjs 用 `typeof logger != "undefined"` 探测主进程注入的全局 logger，
      // 是合法的全局探测写法，这里声明以免 no-undef 误报。
      globals: { ...globals.node, logger: "readonly" },
    },
    rules: {
      // 与 .js/.mjs 用同一套策略。
      // 不写这段的话 `.cjs` 会退回 js.configs.recommended 的默认值，
      // 于是同一个 `catch {}` 写法在 .js 里是 warn、在 .cjs 里是 error
      // （.puppeteerrc.cjs 的 `catch (err) {}` 正因此报了两条）。
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
]
