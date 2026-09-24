import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { clearAuth, DEFAULT_AUTH_HEADER, readAuth, writeAuth } from "@/api/client"

/**
 * 鉴权设置。
 *
 * 「头名」也是**部署相关的**：`server.auth` 是「请求头名 → 令牌」的映射，
 * 键名由部署者自己起（默认示例是 `Authorization`）。所以界面必须让用户同时填
 * 头名与令牌——写死头名会让非默认部署的面板一概 401，而错因很难看出来。
 *
 * 两者都存 localStorage。令牌**不进 URL、不进仓库**（§7.2）。
 */
export const useAuthStore = defineStore("auth", () => {
  const initial = readAuth()

  const header = ref(initial.header)
  const token = ref(initial.token)
  /** 设置对话框是否打开。401 时自动打开，而不是只显示一个错误。 */
  const dialog = ref(false)

  const hasToken = computed(() => token.value.length > 0)

  /** 把当前值写进 localStorage。设置对话框保存时调用。 */
  function save(nextHeader: string, nextToken: string): void {
    header.value = nextHeader.trim() || DEFAULT_AUTH_HEADER
    token.value = nextToken
    writeAuth(header.value, token.value)
    dialog.value = false
  }

  /** 清掉令牌（不影响后端配置，只是让面板不再带着它发请求）。 */
  function forget(): void {
    token.value = ""
    clearAuth()
  }

  /** 请求返回 401 时调用：弹出设置框让人就地补上令牌。 */
  function promptForToken(): void {
    dialog.value = true
  }

  return { header, token, dialog, hasToken, save, forget, promptForToken }
})
