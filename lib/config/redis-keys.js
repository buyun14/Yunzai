/**
 * Redis 键的命名空间与类别前缀。
 *
 * 对应 `docs/refactor/05-persistence-config.md` §3.3。
 *
 * # 要解决的问题
 *
 * 现状是 redis 同时装着两类东西，而**运维时最常见的动作是清空 redis**：
 *
 * - 一类是"过期即失效、可随时重建"的：冷却、去重、上下文、在线/重启标记；
 * - 另一类是"清掉就是丢数据"的：插件调用计数与统计。
 *
 * 两类混在同一个命名空间里时，清空 redis 就是一个需要勇气才能做的动作——
 * 而正是这种"不敢清"，让它慢慢变成谁都不敢碰的黑盒。加前缀之后，
 * 能不能清变成一眼能看出来的事。
 *
 * # 为什么用 `cache:` 而不是分册举例的 `throttle:`
 *
 * §3.3 的表格举例写的是 `throttle:`。但按实际用到的键看，"可随时清"的那一类
 * 里除了冷却/去重，还有**上下文键**（`#添加` 记住用户选的是哪个群）与各种标记，
 * 它们不是节流。用 `cache:` 描述"可重建/过期即失效"更准，
 * 也不至于让人以为"这不是 throttle 所以不用管"。
 *
 * # 为什么保留外层的 `Yz:`
 *
 * `Yz:` 是本仓既有的命名空间（`plugins/system/status.js` 的 `scan` 模式、
 * 例程插件、以及 miao-plugin 里 `Yz:genshin:*` 这类键都在用），类别只作为
 * **第二段**加进去。这样旧键与新键在 `redis-cli KEYS 'Yz:*'` 里仍然属于同一族，
 * 便于迁移期同时观察两代键。
 *
 * # 旧键怎么办
 *
 * **不做一次性迁移**（§5 的 Q4）：这些数据按定义就是可重建的，让旧键自然过期即可。
 * 需要留意的是 `persist:` 那一个——计数是累计值，改名等于从零开始，
 * 这是改名唯一的实际代价，已在 §3.3 登记。
 */

/** 命名空间根 */
export const KEY_ROOT = "Yz"

/** 可随时清空的键：过期即失效，或能由原始数据重建 */
export const CACHE_PREFIX = `${KEY_ROOT}:cache`

/** 清掉会丢数据的键：累计计数、统计 */
export const PERSIST_PREFIX = `${KEY_ROOT}:persist`

/**
 * 拼一个"可随时清"的键。
 *
 * @param {...(string|number)} parts 各段（会自动用 `:` 连接）
 * @returns {string} redis 键
 */
export function cacheKey(...parts) {
  return [CACHE_PREFIX, ...parts].join(":")
}

/**
 * 拼一个"清掉会丢数据"的键。
 *
 * 用它的地方应当能说清"丢了会损失什么"——说不清就该用 `cacheKey()`。
 *
 * @param {...(string|number)} parts 各段（会自动用 `:` 连接）
 * @returns {string} redis 键
 */
export function persistKey(...parts) {
  return [PERSIST_PREFIX, ...parts].join(":")
}
