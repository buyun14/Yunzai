let Common
try {
  Common = (await import("#miao")).Common
} catch {}

const stateArr = {}
const SymbolTimeout = Symbol("Timeout")
const SymbolResolve = Symbol("Resolve")

export default class plugin {
  /**
   * 触发本插件的事件对象。
   *
   * **由外部注入**，基类自己不设置：加载器会逐个 entry 赋值
   * （`lib/pipeline/stages/wakeup-gate.js`），调度器构造实例时也走
   * `Object.assign(new cls(e), { e })`。插件构造时也可能收到一个 e。
   * 因此在被注入之前它是 undefined，代码里读取时都用 `?.` 或先判存在。
   *
   * @type {any}
   */
  e

  /**
   * 会话三要素的遗留写法。
   *
   * `conKey()` 会优先读它们、拿不到再回落到 `this.e.*`。
   * **内核从来没有写过这三个字段**（全仓 grep 只有那几处读取），
   * 因此那条分支实际上是恒走回落的；保留它是因为第三方插件可能自己设置。
   *
   * @type {any}
   */
  self_id
  /** 同上 */
  group_id
  /** 同上 */
  user_id

  /**
   * @param name 插件名称
   * @param dsc 插件描述
   * @param namespace namespace，设置handler时建议设置
   * @param event 执行事件，默认message
   * @param priority 优先级，数字越小优先级越高
   *
   * 下列可选项用描述列表而非 `@param rule.reg` 点号名，理由见
   * docs/refactor/baseline/static-analysis.md §3.4。
   *
   * - `handler` handler配置
   *   - `handler.key` handler支持的事件key
   *   - `handler.fn` handler的处理func
   * - `rule` 命令规则数组
   *   - `rule.reg` 命令正则
   *   - `rule.fnc` 命令执行方法
   *   - `rule.event` 执行事件，默认message
   *   - `rule.log` false时不显示执行日志
   *   - `rule.permission` 权限 master,owner,admin,all
   * - `task` 定时任务
   *   - `task.name` 定时任务名称
   *   - `task.cron` 定时任务cron表达式
   *   - `task.fnc` 定时任务方法名
   *   - `task.log` false时不显示执行日志
   */
  constructor({
    name = "your-plugin",
    dsc = "无",
    handler,
    namespace,
    event = "message",
    priority = 5000,
    task = { name: "", fnc: "", cron: "" },
    rule = [],
  }) {
    /** 插件名称 */
    this.name = name
    /** 插件描述 */
    this.dsc = dsc
    /** 监听事件，默认message https://oicqjs.github.io/oicq/#events */
    this.event = event
    /** 优先级 */
    this.priority = priority
    /** 定时任务，可以是数组 */
    this.task = task
    /** 命令规则 */
    this.rule = rule

    if (handler) {
      this.handler = handler
      this.namespace = namespace || ""
    }
  }

  /**
   * 插件契约：元数据 + 已校验的配置。
   *
   * 由 `lib/plugins/loader.js` 在加载时挂在**插件类**上，因此加载期实例与
   * 每条消息新建的实例都能读到。未提供 `plugin.json` 的插件也有契约
   * （`source` 为 `"legacy"`，`config` 为空对象）。
   *
   * ```js
   * const { metadata, config } = this.contract
   * if (config.enableFoo) { ... }
   * ```
   *
   * 详见 docs/refactor/01-plugin-contract.md
   *
   * @returns {{ metadata: object, config: object, dirName: string, source: "declared"|"legacy" }|null}
   */
  get contract() {
    const ctor =
      /** @type {{ contract?: { metadata: object, config: object, dirName: string, source: "declared"|"legacy" } }} */ (
        this.constructor
      )
    return ctor.contract ?? null
  }

  /**
   * @param msg 发送的消息
   * @param quote 是否引用回复
   * - `data.recallMsg` 群聊是否撤回消息，0-120秒，0不撤回
   * - `data.at` 是否at用户
   */
  reply(msg = "", quote = false, data = {}) {
    if (!this.e?.reply || !msg) return false
    return this.e.reply(msg, quote, data)
  }

  conKey(isGroup = false) {
    return `${this.name}.${this.self_id || this.e.self_id}.${isGroup ? this.group_id || this.e.group_id : this.user_id || this.e.user_id}`
  }

  /**
   * @param type 执行方法
   * @param isGroup 是否群聊
   * @param time 操作时间
   * @param timeout 操作超时回复
   */
  setContext(type, isGroup, time = 120, timeout = "操作超时已取消") {
    const key = this.conKey(isGroup)
    stateArr[key] ??= {}
    const oldContext = stateArr[key][type]
    if (oldContext) {
      clearTimeout(oldContext[SymbolTimeout])
      oldContext[SymbolResolve]?.(false)
    }

    const context = this.e
    stateArr[key][type] = context
    if (time)
      context[SymbolTimeout] = setTimeout(() => {
        if (stateArr[key]?.[type] !== context) return
        const resolve = context[SymbolResolve]
        delete stateArr[key][type]
        if (!Object.keys(stateArr[key]).length) delete stateArr[key]
        resolve ? resolve(false) : this.reply(timeout, true)
      }, time * 1000)
    return context
  }

  getContext(type, isGroup) {
    if (type) return stateArr[this.conKey(isGroup)]?.[type]
    return stateArr[this.conKey(isGroup)]
  }

  finish(type, isGroup) {
    const key = this.conKey(isGroup)
    const context = stateArr[key]?.[type]
    if (context) {
      clearTimeout(context[SymbolTimeout])
      delete stateArr[key][type]
      if (!Object.keys(stateArr[key]).length) delete stateArr[key]
    }
  }

  /**
   * 等待一次上下文。
   *
   * 参数类型写成元组是必需的：`setContext` 是普通签名（不是 rest 参数），
   * 而 TS 要求"展开进普通签名"的值必须是元组，否则报 TS2556。
   *
   * @param {[boolean?, number?, string?]} args 透传给 setContext 的后三个参数
   */
  awaitContext(...args) {
    return new Promise(
      resolve => (this.setContext("resolveContext", ...args)[SymbolResolve] = resolve),
    )
  }

  resolveContext(context) {
    this.finish("resolveContext")
    context?.[SymbolResolve]?.(this.e)
  }

  async renderImg(plugin, tpl, data, cfg) {
    return Common.render(plugin, tpl, data, { ...cfg, e: this.e })
  }
}
