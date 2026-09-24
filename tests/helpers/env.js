/**
 * 测试环境的 L0 全局变量桩。
 *
 * 见 docs/refactor/99-compat-and-migration.md §1.1：`Bot` / `logger` / `redis` /
 * `plugin` / `segment` / `Renderer` 是运行时注入的全局变量，单测里必须替身化。
 *
 * 替身的原则是"够用即可"：只实现被测代码真正会调用的方法，且把调用记录下来
 * 供断言使用，而不是做一个会吸收一切错误的 mock。
 */

/**
 * 造一个记录调用的 logger 替身。
 *
 * 颜色函数（`red` / `green` / …）返回入参本身，因为真实实现（chalk）只是包一层 ANSI 码，
 * 对被测逻辑没有影响。
 *
 * @returns {Record<string, unknown> & { calls: Array<{ level: string, args: unknown[] }> }}
 */
export function createLoggerStub() {
  /** @type {Array<{ level: string, args: unknown[] }>} */
  const calls = []
  const record =
    level =>
    (...args) => {
      calls.push({ level, args })
    }

  const identity = value => value
  return {
    calls,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    mark: record("mark"),
    // chalk 风格的颜色函数
    red: identity,
    green: identity,
    blue: identity,
    yellow: identity,
    cyan: identity,
    magenta: identity,
    gray: identity,
    bold: identity,
  }
}

/**
 * 造一个 `Bot` 替身。
 *
 * @param {{ logger?: object }} [opts] 可选项
 * @returns {Record<string, unknown> & { logs: unknown[][] }}
 */
export function createBotStub(opts = {}) {
  /** @type {unknown[][]} */
  const logs = []
  return {
    logs,
    makeLog(...args) {
      logs.push(args)
    },
    sleep: () => Promise.resolve(),
    sleepTimeout: Symbol("sleepTimeout"),
    getTimeDiff: () => "0毫秒",
    String: value => String(value),
    makeError: (message, ...rest) => Object.assign(new Error(message), { detail: rest }),
    fsStat: async () => null,
    adapter: [],
    wsf: {},
    bots: {},
    uin: [],
    stat: { online: 2 },
    ...opts,
  }
}

/**
 * 安装全部全局替身。
 *
 * 幂等：重复调用会覆盖为新的替身，便于每个测试文件拿到干净的记录数组。
 *
 * @returns {{ logger: ReturnType<typeof createLoggerStub>, Bot: ReturnType<typeof createBotStub> }}
 */
export function installGlobals() {
  const logger = createLoggerStub()
  const Bot = createBotStub()

  globalThis.logger = logger
  globalThis.Bot = Bot
  globalThis.redis = {
    get: async () => null,
    set: async () => "OK",
    setEx: async () => "OK",
    del: async () => 0,
    scan: async () => ["0", []],
    multi: () => ({ incr: () => {}, exec: async () => [] }),
  }
  globalThis.segment = {
    text: text => ({ type: "text", text }),
    image: file => ({ type: "image", file }),
    at: qq => ({ type: "at", qq }),
    reply: id => ({ type: "reply", id }),
    file: (file, name) => ({ type: "file", file, name }),
  }
  // plugin 基类在 lib/plugins/plugin.js 里会被 import，这里只提供占位以便全局引用不报错
  globalThis.plugin ??= class {}

  return { logger, Bot }
}
