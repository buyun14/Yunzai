<script setup lang="ts">
/**
 * 解析后的 YAML 值的递归渲染。
 *
 * # 为什么不直接 `JSON.stringify`
 *
 * 因为**脱敏必须看得见**。后端把密钥键的整个值换成 `***`，并把被遮的路径放在
 * `redacted` 里（`lib/web/api/config.js`）。一段 JSON 里孤零零的 `"auth": "***"`
 * 会被读成「配置本来就长这样」——那比不打码更糟（分册 §4 的原话）。
 * 所以这里在结构里**就地把命中的键标出来**，而不是在页面别处放一句说明。
 *
 * 路径格式与后端一致：对象用 `a.b`，数组元素用 `a[0]`、`a[0].b`。
 */
const props = defineProps<{
  /** 当前值 */
  value: unknown
  /** 被后端脱敏的路径集合 */
  redacted: string[]
  /** 当前路径（根为空串） */
  path?: string
  /** 显示名：对象成员是键名，数组元素是 `[i]`，根是文件本身 */
  label?: string
  /** 嵌套深度，用于缩进 */
  depth?: number
}>()

const INDENT = 16

function childPath(key: string | number, parent: string): string {
  if (typeof key === "number") return `${parent}[${key}]`
  return parent ? `${parent}.${key}` : key
}

function isRedacted(path: string): boolean {
  return props.redacted.includes(path)
}

/** 值的类型，决定用哪种渲染 */
function kindOf(value: unknown): "object" | "array" | "null" | "primitive" {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "object") return "object"
  return "primitive"
}

function entriesOf(value: unknown): Array<[string, unknown]> {
  if (kindOf(value) !== "object") return []
  return Object.entries(value as Record<string, unknown>)
}

function primitiveText(value: unknown): string {
  if (typeof value === "string") return value
  return String(value)
}

function primitiveTone(value: unknown): string {
  if (typeof value === "string") return "text-teal-darken-2"
  if (typeof value === "number") return "text-indigo-darken-2"
  if (typeof value === "boolean") return "text-deep-purple-darken-2"
  return ""
}
</script>

<template>
  <div>
    <!-- 这一层是「键名（或数组下标）+ 值」的一行 -->
    <div
      v-if="label !== undefined"
      class="d-flex align-start"
      :style="{ paddingLeft: `${(depth ?? 0) * INDENT}px` }"
    >
      <span class="text-medium-emphasis mr-2">{{ label }}:</span>

      <!-- 空对象 / 空数组：显式写出来，否则会显示成一个什么都没有的行 -->
      <span
        v-if="kindOf(value) === 'object' && !entriesOf(value).length"
        class="text-medium-emphasis"
      >
        {}
      </span>
      <span
        v-else-if="kindOf(value) === 'array' && !(value as unknown[]).length"
        class="text-medium-emphasis"
      >
        []
      </span>

      <!-- 被脱敏的键：就地标出来，并说明这是后端遮的 -->
      <template v-else-if="isRedacted(path || '')">
        <v-chip size="x-small" color="warning" variant="flat" class="mr-1">***</v-chip>
        <span class="text-caption text-medium-emphasis">该值已由后端脱敏（密钥）</span>
      </template>

      <span v-else-if="kindOf(value) === 'null'" class="text-medium-emphasis">null</span>

      <span v-else-if="kindOf(value) === 'primitive'" :class="primitiveTone(value)">
        {{ primitiveText(value) }}
      </span>
    </div>

    <!-- 对象：递归每个键 -->
    <template v-if="kindOf(value) === 'object' && entriesOf(value).length">
      <ConfigValue
        v-for="[key, child] in entriesOf(value)"
        :key="key"
        :value="child"
        :redacted="redacted"
        :path="childPath(key, path || '')"
        :label="key"
        :depth="label !== undefined ? (depth ?? 0) + 1 : (depth ?? 0)"
      />
    </template>

    <!-- 数组：用下标当标签，与后端的 `a[0]` 路径格式一致 -->
    <template v-else-if="kindOf(value) === 'array'">
      <ConfigValue
        v-for="(child, i) in value as unknown[]"
        :key="i"
        :value="child"
        :redacted="redacted"
        :path="childPath(i, path || '')"
        :label="`[${i}]`"
        :depth="label !== undefined ? (depth ?? 0) + 1 : (depth ?? 0)"
      />
    </template>
  </div>
</template>
