/**
 * 运行时注入的全局变量声明。
 *
 * 见 docs/refactor/99-compat-and-migration.md §1.1「全局对象」：
 * 这些变量由 app.js 与 lib/config/*.js 注入，插件与内核中大量裸用。
 *
 * 声明为 `any` 是刻意的，因为它们本质上是动态的：
 * - `Bot` 是 Proxy，未知属性会回落到 `util` 与 `bots[uin]`（见 lib/bot.js 构造函数）
 * - `logger` 是 chalk 实例
 * - `redis` 由 lib/config/redis.js 注入
 *
 * 后续若需要更强的类型约束，应先在 lib/ 中补 JSDoc，而不是在这里收窄类型。
 */

// 用 declare var 而不是 declare const：
// 只有 var 声明才会成为 globalThis 的属性，这样 `globalThis.logger?.x` 这类写法才有类型。
declare var Bot: any
declare var logger: any
declare var redis: any
declare var plugin: any
declare var segment: any
declare var Renderer: any
declare var start_type: string | undefined

/**
 * `#miao`（`package.json` 的 `imports` 映射到 `plugins/miao-plugin/components/index.js`）。
 *
 * **为什么要在这里声明**：`plugins/miao-plugin` 是 **gitignore** 的，干净克隆与 CI 里
 * 都不存在。于是 `import("#miao")` 在 CI 上报 TS2307、在本机（装了该插件）不报——
 * 同一个 `pnpm typecheck` 在两处结果不同，闸门等于不可复现。
 * 补一条环境声明之后，"这个模块存在"与装没装插件无关，两处结果一致。
 *
 * 声明为 `any` 是如实的：这些符号来自第三方插件，本仓的闸门不检查它
 * （`jsconfig.json` 也把 `plugins/miao-plugin` 排除在外）。本仓自有代码只用到
 * `App` / `Common` / `Version` 三个，都在 `try {} catch {}` 里可选导入。
 *
 * 注意：`package.json` 里 `#miao` / `#miao.models` 的映射本身是 L0 冻结面，不可改动；
 * 这里只是补类型，不涉及运行期。
 */
declare module "#miao" {
  export const App: any
  export const Common: any
  export const Version: any
}
