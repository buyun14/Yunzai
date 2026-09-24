import EventBus from "../event-bus.js"
import PluginsLoader from "../plugins/loader.js"

export default class EventListener {
  /**
   * 事件监听
   *
   * `data.prefix` / `data.event` / `data.once` 三个字段从同一个对象上取，
   * 因此必须先声明 `data` 本身，否则 `checkJs` 报 TS8032（限定名缺 `@param`）。
   *
   * @param {object} data 监听配置
   * @param {string} [data.prefix] 事件名称前缀
   * @param {string|string[]} data.event 监听的事件
   * @param {boolean} [data.once] 是否只监听一次
   */
  constructor(data) {
    this.prefix = data.prefix || ""
    this.event = data.event
    this.once = data.once || false
    this.plugins = PluginsLoader
    /**
     * 事件分派入口。事件一律走 `this.events.commit(e)`。
     *
     * `this.plugins` 是 `PluginsLoader` 单例，保留给旧监听器与插件读加载状态
     * （`priority` / `count` / `dealText()` 等）。它原来的 `deal()` 入口已随
     * 阶段 2 第 5 步删除。
     */
    this.events = EventBus
  }
}
