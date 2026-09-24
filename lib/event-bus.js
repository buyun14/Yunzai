import cfg from "./config/config.js"
import { PipelineContext } from "./pipeline/context.js"
import { PipelineScheduler } from "./pipeline/scheduler.js"
import PluginsLoader from "./plugins/loader.js"
import Runtime from "./plugins/runtime.js"

/**
 * 事件总线需要的加载器接口：只有流水线要的 `priority` / `count`。
 *
 * @typedef {import("./pipeline/context.js").PluginLoader} EventBusLoader
 */

/**
 * 事件总线：把事件按**配置档案**分派给对应的一组流水线阶段实例。
 *
 * 对应文档：docs/refactor/02-pipeline.md §6
 *
 * # 它解决的具体问题
 *
 * 改造前 `lib/events/*.js` 直接 `this.plugins.deal(e)`，而 `PluginsLoader` 是**单例**，
 * 于是 `groupCD` / `singleCD` / `msgThrottle` 是所有账号共享的一张表，
 * 键里还漏了 `self_id`——
 * 同一个群里挂两个 bot 账号时，A 账号触发群冷却会让 B 账号也被静默拦截。
 *
 * 现在每个档案（= `self_id`）拥有独立的 `PipelineScheduler` 与独立的阶段实例，
 * 限流表天然以档案为界。
 *
 * # 没有队列（刻意的，也是必须说清的一点）
 *
 * 计划文档 §6 原本写着"队列消费用 `for await` 串行"，并假设"现状是同账号消息串行处理"。
 * **这个假设是错的**：`Bot.em()` 走的是同步的 `EventEmitter.emit`，
 * 而 `lib/events/*.js` 的 `execute()` 并没有 `await` 返回值——
 * 也就是说旧 `deal()` 的 Promise 是被**丢弃**的，多条消息本来就并发执行。
 * （只有 `deal()` 里第一个 `await` **之前**的那段前缀是每事件原子的，
 * 而限流检查与提交恰好都在那段前缀里，所以限流本身没有被并发破坏。）
 *
 * 因此"v1 保持串行"并不是保持现状，而是**引入**行为变更：
 * 插件处理器会从并发变成串行。那需要单独评估（慢插件会阻塞同账号其他消息，
 * 而插件的隐式时序假设也可能依赖并发）。所以本实现刻意不排队，
 * 只做档案路由——这样切换才真的是"行为等价"。
 *
 * 将来要加队列时，插入点就是 `commit()`：把 `scheduler.execute(event)` 换成
 * 入队 + 由泵消费即可，阶段代码不用动。
 *
 * # 首条消息的额外延迟
 *
 * 档案是懒创建的（`self_id` 只有连接上来才知道），所以每个档案的**第一条**消息
 * 会多一次 await（等阶段实例化完成）。之后的每条消息走同步快路径：
 * `commit()` 在第一个 `await` 之前就调用了 `execute()`，
 * 因此流水线的前缀仍然与 `Bot.emit` 处于同一个 tick——与旧实现一致。
 *
 * 要消除这一次延迟，可以在 `connect.<self_id>` 事件里调用 `prewarm(self_id)`。
 *
 * # 只剩一条路径
 *
 * 阶段 2 第 5 步删除了旧 `PluginsLoader.deal()` 与 `bot.legacy_pipeline` 回退开关，
 * 因此这里不再有任何模式判断：`commit()` 永远路由到流水线。
 */
export class EventBus {
  /**
   * @param {object} opts 构造参数
   * @param {EventBusLoader} opts.loader 插件加载器（流水线读 `priority` 与 `count`）
   * @param {object} opts.cfg 宿主配置对象
   * @param {object} opts.runtime 插件 runtime（注入给 `PreProcessStage`）
   */
  constructor({ loader, cfg: config, runtime }) {
    this.loader = loader
    this.cfg = config
    this.runtime = runtime

    /**
     * 档案表：`self_id` → `{ scheduler, ready }`。
     *
     * `scheduler` 初始化完成后才有值；`ready` 是初始化 Promise，
     * 让并发的首条消息共享同一次初始化而不是各建一套阶段实例。
     *
     * @type {Map<string, { scheduler: PipelineScheduler|null, ready: Promise<void> }>}
     */
    this.profiles = new Map()
  }

  /**
   * 档案标识。沿用 `cfg.getGroup(self_id, group_id)` 的键空间语义：档案 = bot 账号。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {string} 档案标识
   */
  profileKey(event) {
    return String(event?.self_id ?? "")
  }

  /**
   * 取（必要时创建并初始化）某档案的调度器。
   *
   * @param {string} key 档案标识
   * @returns {{ scheduler: PipelineScheduler|null, ready: Promise<void> }} 档案条目
   */
  entryFor(key) {
    let entry = this.profiles.get(key)
    if (entry) return entry

    /** @type {{ scheduler: PipelineScheduler|null, ready: Promise<void> }} */
    entry = { scheduler: null, ready: Promise.resolve() }
    entry.ready = this.createScheduler(key, entry)
    this.profiles.set(key, entry)
    return entry
  }

  /**
   * 实例化并初始化某档案的阶段实例。
   *
   * 初始化失败时**把档案从表里摘掉**：否则一次瞬时失败会永久污染该档案，
   * 后续消息永远拿到一个半初始化的调度器。
   *
   * @param {string} key 档案标识
   * @param {{ scheduler: PipelineScheduler|null, ready: Promise<void> }} entry 档案条目
   * @returns {Promise<void>} 无
   */
  async createScheduler(key, entry) {
    const ctx = new PipelineContext({
      loader: this.loader,
      profileKey: key,
      cfg: this.cfg,
      runtime: this.runtime,
    })
    const scheduler = new PipelineScheduler(ctx)

    try {
      await scheduler.initialize()
    } catch (err) {
      this.profiles.delete(key)
      throw err
    }

    entry.scheduler = scheduler

    // 一条日志，便于确认某个账号确实装配起了流水线（排查「消息没反应」时的第一手线索）
    if (typeof Bot === "object" && Bot?.makeLog)
      Bot.makeLog("mark", `已装配消息流水线（档案 ${key}，${ctx.stages.length} 个阶段）`, "Plugin")
  }

  /**
   * 预热某档案（可选）。在 `connect.<self_id>` 里调用可以消掉首条消息的延迟。
   *
   * @param {unknown} selfId bot 账号
   * @returns {Promise<void>} 无
   */
  async prewarm(selfId) {
    await this.entryFor(String(selfId ?? "")).ready
  }

  /**
   * 提交一条事件。
   *
   * 语义与改造前的 `plugins.deal(e)` 相同：返回 Promise，**调用方是否 await 由它决定**——
   * `lib/events/*.js` 与旧实现一样不 await，因此行为不变。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<unknown>} 处理结果
   */
  async commit(event) {
    const entry = this.entryFor(this.profileKey(event))
    // 快路径：档案已就绪时不 await，让流水线前缀与 Bot.emit 同 tick
    // （旧 deal() 的前缀也是同步跑的，这一步是行为等价的关键）
    if (entry.scheduler) return entry.scheduler.execute(event)

    await entry.ready
    return entry.scheduler?.execute(event)
  }

  /**
   * 关停：丢弃全部档案。
   *
   * 目前只用于测试与将来优雅退出。**不清除阶段里挂的 `setTimeout`**
   * （冷却到期、同文去重），它们与旧 `PluginsLoader` 的行为一致，都是短定时器。
   *
   * @returns {void} 无
   */
  shutdown() {
    this.profiles.clear()
  }
}

/**
 * 全局单例。
 *
 * 与 `lib/plugins/loader.js` 同样的形态：`lib/listener/listener.js` 直接引用它，
 * 避免每个事件监听文件各建一份。
 */
export default new EventBus({ loader: PluginsLoader, cfg, runtime: Runtime })
