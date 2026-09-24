import { onUnmounted, ref, shallowRef, type Ref } from "vue"
import { ApiError } from "@/api/client"
import { useAuthStore } from "@/stores/auth"

/**
 * 一次异步取数的通用状态机。
 *
 * 四个页面都是「加载 → 展示 / 出错」，把这段重复四遍必然会在某一页漏掉
 * 「出错后把 loading 关掉」这类细节（表现为永远转圈）。所以提出来一处实现。
 *
 * `loader` 拿到的是一份 `RequestInit`（内含 `signal`）而不是裸的 `AbortSignal`：
 * `client.ts` 里的每个方法签名都是 `(init?: RequestInit)`，这样调用方
 * 直接把它传进来就行，不需要在每一页各写一层 `signal => getX({ signal })`。
 *
 * 401 特殊处理：**自动弹出令牌设置框**。面板最常见的失败就是忘了填令牌，
 * 让用户自己从一句「鉴权失败」推出该去哪填，是没必要的摩擦。
 *
 * @param loader 取数函数
 * @param options 选项
 * @param options.immediate 是否立刻执行一次（默认 true）
 * @returns 状态与刷新方法
 */
export function useAsync<T>(
  loader: (init: RequestInit) => Promise<T>,
  { immediate = true }: { immediate?: boolean } = {},
) {
  const data = shallowRef<T | null>(null)
  const error = ref<string>("")
  const loading = ref(false)
  /** 上一次成功取数的时间，用于「数据有点旧了」的提示 */
  const loadedAt = ref<number>(0)

  const auth = useAuthStore()
  let controller: AbortController | null = null

  async function run(): Promise<void> {
    // 后一次请求作废前一次：切页面/连点刷新时不希望旧响应覆盖新数据
    controller?.abort()
    controller = new AbortController()
    const current = controller

    loading.value = true
    error.value = ""
    try {
      const result = await loader({ signal: current.signal })
      if (current.signal.aborted) return
      data.value = result
      loadedAt.value = Date.now()
    } catch (err) {
      if (current.signal.aborted) return
      if (err instanceof ApiError) {
        error.value = err.message
        if (err.isUnauthorized) auth.promptForToken()
      } else {
        error.value = err instanceof Error ? err.message : String(err)
      }
    } finally {
      if (!current.signal.aborted) loading.value = false
    }
  }

  onUnmounted(() => controller?.abort())

  if (immediate) void run()

  /** `data` 是 `shallowRef`：这些响应都是整体替换，没有深层响应式的需求 */
  return { data: data as Ref<T | null>, error, loading, loadedAt, refresh: run }
}
