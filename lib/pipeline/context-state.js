/**
 * 每事件状态的存储键。
 *
 * 单独一个文件是为了避免 `context.js` ↔ `scheduler.js` 之间为了这个 Symbol
 * 形成循环依赖。
 */
export const PIPELINE_STATE = Symbol("yunzai.pipeline")
