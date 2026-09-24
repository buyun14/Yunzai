import { callables, checkPermission, instantiate, matchesEvent, replyOf } from "../dispatch.js"
import { registerStage, Stage } from "../stage.js"

/** 星铁命令前缀，与 `PluginsLoader.srReg` 逐字一致 */
const SR_REG = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/

/** 绝区零命令前缀，与 `PluginsLoader.zzzReg` 逐字一致 */
const ZZZ_REG = /^#?(%|％|绝区零|绝区)+/

/**
 * 游戏前缀归一化 + `accept` + `rule` 匹配。对应改造前的 `deal()` 第 12、13、14 步。
 *
 * 这是流水线的**终止段**：它必然调用 `stop(event)`——要么因为命中并执行了插件后终结，
 * 要么因为没有任何插件匹配而终结。因此它不能是"可跳过"的阶段，
 * `matchesEvent` 之类的筛选条件对它没有意义。
 *
 * # 位置敏感：必须在 `WakeupGateStage` 之后
 *
 * 本阶段读 `state.priority`——由 `WakeupGateStage` 写入。
 *
 * 特别注意唤醒门槛 `if (!event.only_reply_at) return` 位于 `WakeupGateStage` 内部、
 * **在 `getContext()` 钩子之后**。因此若把这里的逻辑提前，会连带改变
 * `getContext()` 的执行时机（见 `02-pipeline.md` §2.2 约束 c）。
 *
 * # `Object.defineProperty` 不可重入
 *
 * `isSr` / `isGs` 用 `defineProperty` 定义且未声明 `configurable`，**同一事件对象上
 * 重复定义会抛 TypeError**。正常流程每条事件只经过本阶段一次，
 * 但**影子运行必须使用事件副本**，否则第二次定义就会抛错。
 */
export class ProcessStage extends Stage {
  /**
   * @param {Record<string, unknown>} event 事件对象
   * @returns {Promise<void>}
   */
  async process(event) {
    this.normalizeGamePrefix(event)

    const priority = this.stateOf(event).priority ?? []

    // 优先执行 accept：命中即跳出，未命中的插件继续
    for (const entry of priority) {
      const accept =
        /** @type {((event: Record<string, unknown>) => Promise<unknown>)|undefined} */ (
          entry.plugin.accept
        )
      if (typeof accept !== "function") continue

      const res = await callables(instantiate(entry, event)).accept(event)
      if (res === "return") return this.stop(event)
      if (res) break
    }

    for (const entry of priority) {
      const rules = /** @type {import("../context.js").RuleDecl[]|undefined} */ (entry.plugin.rule)
      if (!rules) continue
      for (const rule of rules) {
        if (rule.event && !matchesEvent(event, rule)) continue
        if (!rule.reg.test(/** @type {string} */ (event.msg))) continue

        const plugin = instantiate(entry, event)
        event.logFnc = `${logger.blue(`[${plugin.name}(${rule.fnc})]`)}`

        const silent = rule.log === false
        Bot.makeLog(
          silent ? "debug" : "info",
          `${event.logText}${event.logFnc}${logger.yellow("[开始处理]")}`,
          false,
        )

        const permission = checkPermission(event, rule)
        if (!permission.ok) {
          if (permission.message) await replyOf(event)(permission.message)
          return this.stop(event)
        }

        // 处理器返回 false 表示"这个插件认为命令不是给自己的"，
        // 此时**继续尝试同一插件的后续规则**——因此不能在此直接终止
        if (!(await this.runHandler(plugin, rule, event, silent))) continue
        return this.stop(event)
      }
    }

    Bot.makeLog("debug", `${event.logText}${logger.blue("[暂无插件处理]")}`, false)
    this.stop(event)
  }

  /**
   * 调用插件处理器并记录耗时日志。
   *
   * 处理器抛出异常时**只记日志、不向上抛**——单个插件崩溃不应该中断整条流水线，
   * 但该规则视为已命中（返回 `true`），不再尝试后续规则。
   *
   * @param {Record<string, unknown>} plugin 插件实例
   * @param {import("../context.js").RuleDecl} rule 命令规则
   * @param {Record<string, unknown>} event 事件对象
   * @param {boolean} silent 是否降级日志级别
   * @returns {Promise<boolean>} 是否已把事件视为处理完毕（`false` = 继续尝试后续规则）
   */
  async runHandler(plugin, rule, event, silent) {
    const start = Date.now()
    try {
      // ⚠️ 必须是**方法调用**：插件处理器普遍用 `this.e` 取事件
      // （miao-plugin 的 `components/App.js` 就是），
      // 拆成裸函数调用会丢掉 this，抛 `Cannot read properties of undefined (reading 'e')`。
      // 旧实现写的是 `plugin[v.fnc](e)`，同样是方法调用。
      // 这个坑是真实启动端到端验证时抓到的——单测夹具当时用的箭头函数不碰 this，所以漏了。
      const instance = callables(plugin)
      const res =
        typeof instance[rule.fnc] === "function" ? await instance[rule.fnc](event) : undefined
      if (res === false) return false

      Bot.makeLog(
        silent ? "debug" : "mark",
        `${event.logText}${event.logFnc}${logger.green(`[完成${Bot.getTimeDiff(start)}]`)}`,
        false,
      )
      return true
    } catch (err) {
      Bot.makeLog("error", [`${event.logText}${event.logFnc}`, err], false)
      return true
    }
  }

  /**
   * 游戏命令前缀归一化。
   *
   * `isSr` / `isGs` 是**访问器属性**（`get`/`set` 联动同一份 `e.game`），不是三个独立字段。
   * `zzz` 只写 `game`、不参与 `isSr`/`isGs` 的读写，与旧实现一致。
   *
   * @param {Record<string, unknown>} event 事件对象
   * @returns {void}
   */
  normalizeGamePrefix(event) {
    Object.defineProperty(event, "isSr", {
      get: () => event.game === "sr",
      // 刻意不写成 `v => (event.game = ...)`：那会让 setter 隐式返回一个值，
      // 触发 `no-setter-return`（`lib/plugins/loader.js` 的原实现就有这两条错误）。
      // setter 的返回值在 JS 里会被忽略，改写成块体不影响任何行为。
      set: v => {
        event.game = v ? "sr" : "gs"
      },
    })
    Object.defineProperty(event, "isGs", {
      get: () => event.game === "gs",
      set: v => {
        event.game = v ? "gs" : "sr"
      },
    })

    const msg = /** @type {string} */ (event.msg)
    if (SR_REG.test(msg)) {
      event.game = "sr"
      event.msg = msg.replace(SR_REG, "#星铁")
    } else if (ZZZ_REG.test(msg)) {
      event.game = "zzz"
      event.msg = msg.replace(ZZZ_REG, "#绝区零")
    }
  }
}

registerStage(ProcessStage)
