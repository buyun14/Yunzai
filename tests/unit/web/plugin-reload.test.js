import { describe, expect, it, vi } from "vitest"
import { createPluginReloadHandler } from "../../../lib/web/api/plugin-reload.js"

/**
 * 插件重载的测试。
 *
 * 重载本身复用内核的 `changePlugin()`（热更新走的就是它），所以这里**不重测
 * 内核行为**，只测这一层的责任：
 *
 * 1. **key 的路径包含检查**——`changePlugin` 会把 key 拼进 `../../plugins/<key>`
 *    去 `import()`，所以一个没挡住的 `../` 等于任意模块加载。这是这一层唯一
 *    真正危险的地方。
 * 2. 只接受加载器报告过的 key（拼错了给 404 而不是让它去抛错）。
 * 3. 结果如实回报：重载后插件还在不在。
 */

/** 造一个最小响应对象 */
function resOf() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      res.statusCode = code
      return res
    },
    set() {
      return res
    },
    type() {
      return res
    },
    json(body) {
      res.body = JSON.stringify(body)
      return res
    },
    send(body) {
      res.body = body
      return res
    },
  }
  return res
}

/**
 * 调一次处理器。
 *
 * @param {object} handler 处理器
 * @param {object} req 请求替身
 * @returns {Promise<{status: number, json: any}>} 结果
 */
async function call(handler, req) {
  const res = resOf()
  await handler(req, res, err => {
    throw err
  })
  return { status: res.statusCode, json: res.body ? JSON.parse(String(res.body)) : undefined }
}

/**
 * 造一个加载器替身。
 *
 * @param {object} [opts] 选项
 * @param {string[]} [opts.keys] 已加载的 key
 * @param {(key: string) => void} [opts.onChange] changePlugin 的行为
 * @returns {any} 加载器替身
 */
function loaderOf({ keys = ["other/sendLog.js"], onChange } = {}) {
  const loader = {
    priority: keys.map(key => ({ key, name: key })),
    changePlugin: vi.fn(async key => {
      onChange?.(key)
    }),
  }
  return loader
}

describe("POST /api/v1/plugins/{key}/reload", () => {
  it("重载成功：调用内核的 changePlugin 并回报结果", async () => {
    const loader = loaderOf()
    const { status, json } = await call(createPluginReloadHandler({ loader }), {
      params: { key: "other/sendLog.js" },
    })

    expect(status).toBe(200)
    expect(json.reloaded).toBe(true)
    // 重载不需要重启
    expect(json.restartRequired).toBe(false)
    // 用内核那套（带 ESM 缓存破除与失败回滚），不是我们自己卸了再装
    expect(loader.changePlugin).toHaveBeenCalledWith("other/sendLog.js")
    // 如实说明"插件间依赖要重启"
    expect(json.note).toContain("依赖")
  })

  it("重载后插件不在列表里 → 500 并提示看日志", async () => {
    // 模拟"新代码有错"：changePlugin 之后 key 从 priority 里消失
    const loader = loaderOf({
      onChange: key => {
        loader.priority = loader.priority.filter(entry => entry.key !== key)
      },
    })
    const { status, json } = await call(createPluginReloadHandler({ loader }), {
      params: { key: "other/sendLog.js" },
    })

    expect(status).toBe(500)
    expect(json.reloaded).toBe(false)
    expect(json.note).toContain("日志")
  })

  it("挡住路径穿越（key 会被拼进 import 路径，这是这一层最危险的地方）", async () => {
    const loader = loaderOf()
    const handler = createPluginReloadHandler({ loader })

    for (const key of [
      "../package.json",
      "..%2Fpackage.json",
      "other/../../../../etc/passwd",
      "C:/Windows/system32/evil.js",
      "other\\sendLog.js",
      "/etc/passwd",
    ]) {
      const { status, json } = await call(handler, { params: { key } })
      expect(status, key).toBe(400)
      expect(json.message, key).toContain("不合法")
    }
    // 一个都不该走到内核那条路径上
    expect(loader.changePlugin).not.toHaveBeenCalled()
  })

  it("未知 key → 404（并告诉去哪拿正确的 key）", async () => {
    const loader = loaderOf()
    const { status, json } = await call(createPluginReloadHandler({ loader }), {
      params: { key: "other/没有这个.js" },
    })

    expect(status).toBe(404)
    expect(json.message).toContain("/api/v1/plugins")
    expect(loader.changePlugin).not.toHaveBeenCalled()
  })

  it("缺少 key → 400", async () => {
    const { status, json } = await call(createPluginReloadHandler({ loader: loaderOf() }), {
      params: {},
    })
    expect(status).toBe(400)
    expect(json.message).toContain("key")
  })

  it("加载器不支持重载 → 503（而不是抛错）", async () => {
    const loader = { priority: [{ key: "a.js" }] }
    const { status, json } = await call(createPluginReloadHandler({ loader }), {
      params: { key: "a.js" },
    })
    expect(status).toBe(503)
    expect(json.message).toContain("不支持")
  })

  it("没有 loader 时不抛错（面板其余功能不受影响）", async () => {
    const { status } = await call(createPluginReloadHandler({ loader: undefined }), {
      params: { key: "a.js" },
    })
    // priority 取不到 → known 为空 → 404，关键是不抛
    expect(status).toBe(404)
  })
})
