/**
 * `/api/v1` 的客户端。手写 fetch，不引依赖（见 `types.ts` 顶部的说明）。
 *
 * 三件事在这里统一收掉，页面里不再各写一遍：
 *
 * 1. **鉴权头**。头名与令牌都来自 `server.auth`（键名 = 请求头名），
 *    所以头名是**部署相关的**，不能写死成 `Authorization`。两者都存在 localStorage，
 *    由设置对话框填。令牌**不进 URL**——那会写进访问日志与浏览器历史（§7.2）。
 * 2. **错误形状**。非 2xx 统一抛 `ApiError`，并把状态码翻成一句能照做的中文
 *    （401 去填令牌、429 等几秒、503 等启动完成）。页面只需要展示 `message`。
 * 3. **SSE 解析**。日志流用 `fetch` + `ReadableStream` 而不是 `EventSource`：
 *    后者**不能带自定义请求头**，而这里恰好需要带令牌。
 * 4. **写请求**另走 `sendJSONRequest`：它多了请求体序列化与 `Content-Type`
 *    （后端挂的是 `express.json()`，不声明就解析不到 body）。
 */

import type {
  ApiErrorBody,
  ConfigFile,
  ConfigList,
  ConfigSchemas,
  ConfigWriteResult,
  LogLine,
  Plugins,
  Ready,
  Status,
} from "./types"

/** 面板自己的前缀。宿主把它挂在 `lib/web/server.js` 的 `API_PREFIX`。 */
const API_BASE = "/api/v1"

const TOKEN_KEY = "yunzai.dashboard.token"
const HEADER_KEY = "yunzai.dashboard.header"

/** 默认头名。与 `docs/openapi.yaml` 里 `securitySchemes.serverAuth` 的示例一致。 */
export const DEFAULT_AUTH_HEADER = "Authorization"

/**
 * 鉴权信息。放 localStorage 而不是 cookie：
 * 后端用的是静态头比对（不是会话），没有「登出」语义，本地存一份即可。
 */
export function readAuth(): { header: string; token: string } {
  return {
    header: localStorage.getItem(HEADER_KEY) || DEFAULT_AUTH_HEADER,
    token: localStorage.getItem(TOKEN_KEY) || "",
  }
}

export function writeAuth(header: string, token: string): void {
  localStorage.setItem(HEADER_KEY, header.trim() || DEFAULT_AUTH_HEADER)
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY)
}

/** 请求失败。`status` 为 `0` 表示请求根本没发出去（网络/被中断）。 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }

  /** 401：令牌缺失或不对。界面据此弹设置框，而不是显示一个干巴巴的错误。 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/**
 * 把状态码翻成能照做的一句话。
 *
 * `401` 的响应体是**纯文本** `Unauthorized`（由宿主 `serverAuth` 产生，
 * 不走 JSON 错误形状），所以这里不能去解析 body。
 */
function describe(status: number, body: ApiErrorBody | null): string {
  if (body?.message) return body.message
  switch (status) {
    case 401:
      return "鉴权失败：令牌缺失或不正确，请在右上角填入 server.auth 里配置的令牌"
    case 429:
      return "请求过于频繁（per-IP 限流），稍等几秒再试"
    case 503:
      return "宿主还没有完成启动，请稍后重试"
    case 404:
      return "接口不存在（是不是后端版本比面板旧？）"
    default:
      return status === 0 ? "请求没有发出去" : `请求失败：HTTP ${status}`
  }
}

/**
 * 发一个 GET 并解析 JSON。
 *
 * @param path 相对 `/api/v1` 的路径
 * @param init 额外请求参数（如 `signal`）
 * @returns 解析后的响应体
 */
async function getJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { header, token } = readAuth()
  const headers: Record<string, string> = { Accept: "application/json" }
  // 空令牌也带上头：后端在 auth 为空时会放行，带上空串只是让 401 更快出现，
  // 而「不带头」在某些代理上会被当成畸形请求。
  headers[header] = token

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  } catch (err) {
    // 主动 abort 的情况交给调用方判断，这里不包装成 ApiError
    if (err instanceof DOMException && err.name === "AbortError") throw err
    throw new ApiError(0, "network_error", describe(0, null))
  }

  if (!res.ok) {
    // 401 是纯文本，其余是 JSON；都失败就退回状态码本身的说明
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      body = null
    }
    throw new ApiError(res.status, body?.code ?? `http_${res.status}`, describe(res.status, body))
  }

  return (await res.json()) as T
}

export function getReady(init?: RequestInit): Promise<Ready> {
  return getJSON<Ready>("/ready", init)
}

export function getStatus(init?: RequestInit): Promise<Status> {
  return getJSON<Status>("/status", init)
}

export function getPlugins(init?: RequestInit): Promise<Plugins> {
  return getJSON<Plugins>("/plugins", init)
}

export function getConfigList(init?: RequestInit): Promise<ConfigList> {
  return getJSON<ConfigList>("/config", init)
}

/**
 * 取单个配置文件。
 *
 * `name` 必须来自清单（`/config`）——后端的白名单是
 * `^[\w.-]+\.ya?ml$` 且要求 `basename` 等于原名，自己拼路径只会拿到 400。
 * 这里仍然 encodeURIComponent：文件名本身是合法的，但不编码会让
 * `/` 之类的可疑字符在日志里看起来像穿越尝试。
 */
export function getConfigFile(name: string, init?: RequestInit): Promise<ConfigFile> {
  return getJSON<ConfigFile>(`/config/${encodeURIComponent(name)}`, init)
}

/**
 * 取宿主配置的 schema（v2 表单用）。
 *
 * 返回 `{ schemas, unmodeled }`。**`unmodeled` 必须一起用**：
 * 它列的是"明确不建模"的文件与原因，前端据此让用户原始编辑；
 * 只读 `schemas` 的话，那些文件会表现为"界面上凭空少了一个"。
 */
export function getConfigSchemas(init?: RequestInit): Promise<ConfigSchemas> {
  return getJSON<ConfigSchemas>("/config/schemas", init)
}

/**
 * 写入一个配置文件。
 *
 * # 两件必须做的事
 *
 * 1. **带 `confirmed: true`**：后端要求显式确认，缺了会返回 428
 *    （不是 400——那样客户端才能区分"参数错了"与"还没确认"）。
 * 2. **只提交想改的键**：后端是逐个 `set`，没提交的键在文件里原样保留
 *    （包括用户手写的注释）。所以调用方传的是**增量**，不是整份配置。
 *
 * 后端的四道闸门（文件名白名单 / 已建模 / 不含 `server.yaml` 的
 * `auth`·`https` / 过 schema 校验）都由它自己保证；这里只负责把错误
 * message 原样交给界面显示——那些文案是给人看的、可直接照做。
 */
export function putConfigFile(
  name: string,
  config: Record<string, unknown>,
  init?: RequestInit,
): Promise<ConfigWriteResult> {
  return sendJSONRequest<ConfigWriteResult>(
    `/config/${encodeURIComponent(name)}`,
    { config, confirmed: true },
    { method: "PUT", ...init },
  )
}

/**
 * 发一个带 JSON 请求体的写请求。
 *
 * 与只读的 `getJSON` 分成两个函数而不是加参数：写请求多了两件只读没有的事
 * ——请求体要序列化、`Content-Type` 必须声明（后端挂的是 `express.json()`，
 * 不声明就解析不到 body，表现为"config 必须是一个对象"这种莫名其妙的错误）。
 *
 * `payload` 与 `init` 分开两个参数：合并成一个对象时 `body` 的类型会与
 * `RequestInit.body`（`BodyInit`）冲突，而这里是"任意可序列化的值"。
 *
 * @param path 相对 `/api/v1` 的路径
 * @param payload 要序列化成 JSON 的请求体
 * @param init 其余请求参数（如 `signal`）
 * @returns 解析后的响应体
 */
async function sendJSONRequest<T>(
  path: string,
  payload: unknown,
  init: RequestInit = {},
): Promise<T> {
  const { header, token } = readAuth()

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      method: init.method ?? "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [header]: token,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err
    throw new ApiError(0, "network_error", describe(0, null))
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      body = null
    }
    throw new ApiError(res.status, body?.code ?? `http_${res.status}`, describe(res.status, body))
  }

  return (await res.json()) as T
}

/**
 * 订阅日志流。返回一个「停止」函数。
 *
 * # 为什么不用 EventSource
 *
 * 它不能设置请求头，而面板的令牌恰恰要放在头里。所以用 `fetch` 手动读
 * `ReadableStream` 并解析 SSE 帧（`event: log` / `data: {...}` / 空行分隔）。
 *
 * # 心跳
 *
 * 服务端每 15 秒发一行 `: ping` 注释保活。解析器**忽略注释行**，
 * 但调用方可以用 `onPing` 判断「连接还活着」——连着两个周期没有心跳就该重连。
 *
 * @param handlers 事件回调
 * @param options 附加选项
 * @returns 停止订阅的函数（幂等）
 */
export function streamLogs(
  handlers: {
    onLine: (line: LogLine) => void
    onError: (err: ApiError) => void
    onPing?: () => void
    onOpen?: () => void
  },
  { limit }: { limit?: number } = {},
): () => void {
  const controller = new AbortController()
  const { header, token } = readAuth()
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : ""

  void (async () => {
    let res: Response
    try {
      res = await fetch(`${API_BASE}/logs${query}`, {
        headers: { [header]: token, Accept: "text/event-stream" },
        signal: controller.signal,
      })
    } catch {
      if (!controller.signal.aborted)
        handlers.onError(new ApiError(0, "network_error", describe(0, null)))
      return
    }

    if (!res.ok || !res.body) {
      handlers.onError(new ApiError(res.status, `http_${res.status}`, describe(res.status, null)))
      return
    }

    handlers.onOpen?.()

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 帧以空行分隔。最后一段可能不完整，留在 buffer 里等下一块。
        let split: number
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          handleFrame(frame, handlers)
        }
      }
    } catch {
      // abort 会在这里抛出，属正常收尾
    } finally {
      reader.releaseLock?.()
    }
  })()

  return () => controller.abort()
}

/**
 * 解析一个 SSE 帧并分发。
 *
 * @param frame 帧文本（不含结尾的空行）
 * @param handlers 回调
 * @returns 无
 */
function handleFrame(
  frame: string,
  handlers: { onLine: (line: LogLine) => void; onPing?: () => void },
): void {
  // 一段里可能有 `event:` 与 `data:` 两行；data 也可能出现多行（按 SSE 规范要拼接）
  const dataLines: string[] = []
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.startsWith(":")) {
      // 注释行（心跳 `: ping`）
      handlers.onPing?.()
      continue
    }
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
  }
  if (!dataLines.length) return

  try {
    handlers.onLine(JSON.parse(dataLines.join("\n")) as LogLine)
  } catch {
    // 单帧解析失败不该拖垮整个流：丢掉它继续读
  }
}
