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

declare const Bot: any
declare const logger: any
declare const redis: any
declare const plugin: any
declare const segment: any
declare const Renderer: any
declare var start_type: string | undefined
