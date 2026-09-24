import { HOST_SCHEMAS, UNMODELED } from "../../config/host-schema.js"
import { sendJSON } from "../security.js"

/**
 * `GET /api/v1/config/schemas`：把宿主配置的 schema 交给前端。
 *
 * 对应 `docs/refactor/06-webui.md` §3.5 的 v2（配置编辑）。**只读**，
 * 是 v2 三步里的第一步：schema 端点 → 写入端点 → 前端表单。
 *
 * # 为什么要单独一个"列表"端点，而不是 `/config/{name}/schema`
 *
 * 两个原因：
 *
 * 1. **路由冲突**。`/config/:name` 已经占了那个位置，而 `schema` 恰好能匹配
 *    `:name`（然后被文件名白名单拒掉）。要做成子路径就得动既有路由的形状。
 * 2. **前端一次就能决定怎么渲染整个页面**：哪些文件能出表单、哪些只能原始编辑。
 *    拆成每文件一次请求，前端要先逐个试探才知道该显示什么。
 *
 * # 返回什么、为什么
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `schemas` | `文件名 → 受控子集 schema`。前端照它渲染表单 |
 * | `unmodeled` | `[{ name, reason }]`：**明确不建模**的文件与原因 |
 *
 * 把 `unmodeled` 一起返回是刻意的：前端必须能区分"这个文件只能原始编辑（有理由）"
 * 与"这个文件没拿到 schema（可能是漏了）"。只给 `schemas` 的话，
 * `group.yaml` 会表现为"界面上凭空少了一个文件"，而真正的原因
 * （顶层是动态键，受控子集表达不了）就丢了。
 *
 * # 边界
 *
 * - 输出的是**描述**，不是配置值，所以没有密钥需要脱敏；
 * - 但仍然是宿主内部结构的公开面，所以只暴露受控子集认识的那几个关键字——
 *   `HOST_SCHEMAS` 里本来就只有这些（见 `lib/config/host-schema.js`）。
 *
 * @param {object} [deps] 依赖
 * @param {Record<string, object>} [deps.schemas] schema 表（测试可注入）
 * @param {Record<string, string>} [deps.unmodeled] 未建模名单（测试可注入）
 * @returns {(req: import("express").Request, res: import("express").Response) => void} 处理器
 */
export function createSchemasHandler({ schemas = HOST_SCHEMAS, unmodeled = UNMODELED } = {}) {
  return (req, res) => {
    // 深拷贝一份再发：`sendJSON` 里虽然是同步序列化，但把模块级单例
    // 直接交出去等于允许调用方改到全局状态，代价只有一次 clone
    const cloned = structuredClone(schemas)

    sendJSON(res, 200, {
      schemas: cloned,
      unmodeled: Object.entries(unmodeled).map(([name, reason]) => ({ name, reason })),
    })
  }
}
