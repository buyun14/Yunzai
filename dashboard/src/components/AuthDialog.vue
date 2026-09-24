<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { DEFAULT_AUTH_HEADER } from "@/api/client"
import { useAuthStore } from "@/stores/auth"

/**
 * 令牌设置对话框。
 *
 * 两个字段都是必需的——**头名**也是部署相关的：`server.auth` 的键名就是请求头名，
 * 只有默认配置才恰好叫 `Authorization`。把令牌存 localStorage，
 * 不进 URL、不进仓库（`06-webui.md` §7.2）。
 */
const auth = useAuthStore()

const header = ref(auth.header)
const token = ref(auth.token)
const reveal = ref(false)

// 每次打开都从 store 重新取值：别的地方（如 401 之后）可能已经改过
watch(
  () => auth.dialog,
  open => {
    if (!open) return
    header.value = auth.header
    token.value = auth.token
    reveal.value = false
  },
)

const valid = computed(() => token.value.trim().length > 0)

function save(): void {
  if (!valid.value) return
  auth.save(header.value, token.value)
}
</script>

<template>
  <v-dialog v-model="auth.dialog" max-width="620" persistent>
    <v-card>
      <v-card-title>面板鉴权</v-card-title>
      <v-card-text>
        <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
          令牌对应宿主 <code>config/config/server.yaml</code> 里的
          <code>server.auth</code>。它是一个「请求头名 → 令牌」的映射，
          <strong>键名就是这里要填的头名</strong>。
        </v-alert>

        <v-text-field
          v-model="header"
          label="请求头名"
          :placeholder="DEFAULT_AUTH_HEADER"
          density="comfortable"
          variant="outlined"
          hint="server.auth 的键名，默认示例为 Authorization"
          persistent-hint
          class="mb-4"
        />

        <v-text-field
          v-model="token"
          label="令牌"
          :type="reveal ? 'text' : 'password'"
          :append-inner-icon="reveal ? 'mdi-eye-off' : 'mdi-eye'"
          density="comfortable"
          variant="outlined"
          autocomplete="off"
          hint="只保存在这个浏览器里；不会进 URL，也不会写进仓库"
          persistent-hint
          @click:append-inner="reveal = !reveal"
          @keyup.enter="save"
        />
      </v-card-text>

      <v-card-actions>
        <v-btn v-if="auth.hasToken" variant="text" color="error" @click="auth.forget()">
          清除令牌
        </v-btn>
        <v-spacer />
        <v-btn variant="text" @click="auth.dialog = false">稍后</v-btn>
        <v-btn color="primary" variant="flat" :disabled="!valid" @click="save">保存</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
