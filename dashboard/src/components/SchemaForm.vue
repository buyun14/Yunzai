<script setup lang="ts">
import { ref } from "vue"
import type { SchemaField } from "@/api/types"

/**
 * 由受控子集 schema 渲染的表单（**递归**组件）。
 *
 * # 数据流：就地编辑父组件传进来的对象，而不是逐字段 emit
 *
 * 嵌套结构（`milky.webhook.path`、`server.webui.enable`）如果每层都 emit，
 * 父组件就得自己拼路径更新对象，代码会散成一片。所以约定：`model` 是父组件的
 * **响应式对象**，本组件就地改字段。改了什么由父组件用快照对比算出来
 * （见 ConfigView 的 `changedKeys`）——那正好也是提交增量所需的形状。
 *
 * 代价是组件不再纯粹；收益是递归结构两层组件就够了。
 *
 * # `x-widget` 决定控件
 *
 * | 值 | 控件 |
 * |---|---|
 * | `password` | 默认遮住的文本框 |
 * | `textarea` | 多行文本 |
 * | `select` | 下拉（需配 `enum`） |
 * | `raw` | **不渲染**（那句"请在 yaml 里改"由父组件统一说一次，见下） |
 * | 其余 | 按 `type`：boolean → 开关、integer/number → 数字、string → 文本 |
 *
 * # 两个刻意的"不在这里渲染"
 *
 * 1. **`raw` 的键**（`server.auth`、`server.https`）直接跳过。它们本来是
 *    "任意键名映射"或"要么都填要么都不填"的结构，渲染成表单只会误导；
 *    父组件会在表单上方统一给出"这些键请在 yaml 里改"的说明——
 *    每个键各说一次是噪声。
 * 2. **后端封死的键**（`server.auth`/`https` 在写入侧被 BCR-0004 拒绝）：
 *    父组件通过 `readOnlyKeys` 传进来，我们渲染成**禁用**并写明原因。
 *    否则用户填完点保存才被 400 拒掉，而他已经花了时间。
 */

defineOptions({ name: "SchemaForm" })

const props = defineProps<{
  schema: SchemaField
  /** 就地编辑的对象（父组件的响应式对象） */
  model: Record<string, unknown>
  /** 键名 → 禁止编辑的原因。命中的键渲染成禁用 */
  readOnlyKeys?: Record<string, string>
  /** 键名 → 该键标了 `raw`，本组件跳过 */
  rawKeys?: Record<string, boolean>
  /** 嵌套深度，仅用于缩进 */
  depth?: number
}>()

/** 数组项的编辑缓冲（按"每行一项"编辑），避免对数组做直接 v-model */
const drafts = ref<Record<string, string>>({})

/** 顶层字段列表 */
function entriesOf(schema: SchemaField): Array<[string, SchemaField]> {
  return Object.entries(schema.properties ?? {})
}

/**
 * 字段的类型集合（`type` 可能是单个字符串或联合类型的数组）。
 *
 * @param field 字段 schema
 * @returns 类型名数组
 */
function typesOf(field: SchemaField): string[] {
  // `type` 可以缺省（只给了 title 的字段），这时按 string 处理
  if (Array.isArray(field.type)) return field.type.filter((item): item is string => !!item)
  return field.type ? [field.type] : []
}

/**
 * 按类型推断控件时要用的"主类型"。
 *
 * 联合类型（`["string","null"]`）里 `null` 不是控件，真正的形状由另一个成员决定。
 *
 * @param field 字段 schema
 * @returns 主类型名
 */
function primaryType(field: SchemaField): string {
  const all = typesOf(field).filter(Boolean)
  return all.find(t => t !== "null") ?? "string"
}

/**
 * 字段的默认值：schema 没写 default 时按主类型给个空值。
 *
 * 不给的话控件会显示 `undefined`，而用户看到"空白"与"未定义"是两回事。
 *
 * @param field 字段 schema
 * @returns 默认值
 */
function fallback(field: SchemaField): unknown {
  if ("default" in field) return field.default
  switch (primaryType(field)) {
    case "array":
      return []
    case "boolean":
      return false
    case "integer":
    case "number":
      return 0
    default:
      return ""
  }
} /**
 * 取某个键当前可编辑的值。
 *
 * 值缺失时**不写回** model：写回会把"用户没碰过的键"也变成提交项，
 * 而提交项里带上没改的键就是一次无意义的写入。
 *
 * @param key 键名
 * @param field 字段 schema
 * @returns 当前值
 */
function valueOf(key: string, field: SchemaField): unknown {
  const current = props.model[key]
  return current === undefined ? fallback(field) : current
}

/**
 * 枚举候选（没有则返回 null，表示不该用下拉）。
 *
 * @param field 字段 schema
 * @returns 候选值数组或 null
 */
function enumOf(field: SchemaField): unknown[] | null {
  return Array.isArray(field.enum) && field.enum.length ? field.enum : null
}

/**
 * 数组值 → 每行一项的文本。
 *
 * @param value 数组值
 * @returns 文本
 */
function arrayToText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value.map(item => (typeof item === "string" ? item : JSON.stringify(item))).join("\n")
}

/**
 * 每行一项的文本 → 数组值。
 *
 * 纯数字的项还原成数字：`blackGroup: [213938015]` 这类出厂值本来就是数字，
 * 运行期两种写法都认（`loader.js` 用 `Number(id) || String(id)`），
 * 但**保持用户原来的形态**更不容易让人困惑。
 *
 * @param text 文本
 * @returns 数组值
 */
function textToArray(text: string): unknown[] {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => (/^-?\d+$/.test(line) ? Number(line) : line))
}

function arrayText(key: string, field: SchemaField): string {
  if (drafts.value[key] === undefined) drafts.value[key] = arrayToText(valueOf(key, field))
  return drafts.value[key]
}

function onArrayInput(key: string, text: string): void {
  drafts.value[key] = text
  props.model[key] = textToArray(text)
}

/**
 * 取禁用原因（没有则空串）。
 *
 * @param key 键名
 * @returns 原因
 */
function readOnlyReason(key: string): string {
  const reason = props.readOnlyKeys?.[key]
  return reason ?? ""
}

/**
 * 取嵌套对象的值，缺失时就地建一个空对象。
 *
 * 必须在**函数**里建：写成 `:model="model[key] ?? (model[key] = {})"` 会让
 * 模板求值产生副作用，而模板可能渲染多次、还会在只读渲染里被调到。
 *
 * @param key 键名
 * @param field 字段 schema
 * @returns 该键对应的对象
 */
function objectValue(key: string, field: SchemaField): Record<string, unknown> {
  const current = props.model[key]
  if (current !== null && typeof current === "object" && !Array.isArray(current))
    return current as Record<string, unknown>

  const created = fallback(field)
  const value =
    created !== null && typeof created === "object" && !Array.isArray(created) ? created : {}
  props.model[key] = value
  return value as Record<string, unknown>
}

/**
 * 禁用的键展示成一行只读文本。
 *
 * @param value 值
 * @returns 展示文本
 */
function displayOf(value: unknown): string {
  if (value === null || value === undefined) return "（未配置）"
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}
</script>

<template>
  <div>
    <template v-for="[key, field] in entriesOf(schema)" :key="key">
      <!-- raw：本组件不渲染，父组件会统一说明 -->
      <template v-if="rawKeys?.[key]"></template>

      <!-- 后端封死：禁用 + 说明原因 -->
      <v-text-field
        v-else-if="readOnlyReason(key)"
        :model-value="displayOf(model[key])"
        :label="field.title || key"
        :hint="readOnlyReason(key)"
        persistent-hint
        readonly
        disabled
        density="comfortable"
        variant="outlined"
        prepend-inner-icon="mdi-lock-outline"
        class="mb-4"
      />

      <!-- 布尔 -->
      <div v-else-if="primaryType(field) === 'boolean'" class="mb-3">
        <v-switch
          :model-value="Boolean(valueOf(key, field))"
          :label="field.title || key"
          color="primary"
          density="comfortable"
          hide-details
          @update:model-value="v => (model[key] = v)"
        />
        <div v-if="field.description" class="text-caption text-medium-emphasis ml-10">
          {{ field.description }}
        </div>
      </div>

      <!-- 枚举下拉 -->
      <v-select
        v-else-if="enumOf(field)"
        :model-value="valueOf(key, field)"
        :items="enumOf(field)!.map(v => ({ title: String(v), value: v }))"
        :label="field.title || key"
        :hint="field.description"
        persistent-hint
        density="comfortable"
        variant="outlined"
        class="mb-4"
        @update:model-value="v => (model[key] = v)"
      />

      <!-- 数组：每行一项 -->
      <v-textarea
        v-else-if="primaryType(field) === 'array'"
        :model-value="arrayText(key, field)"
        :label="field.title || key"
        :hint="field.description ? `${field.description}（每行一项）` : '每行一项'"
        persistent-hint
        rows="3"
        density="comfortable"
        variant="outlined"
        class="mb-4"
        @update:model-value="v => onArrayInput(key, v)"
      />

      <!-- 数字 -->
      <v-text-field
        v-else-if="primaryType(field) === 'integer' || primaryType(field) === 'number'"
        :model-value="valueOf(key, field)"
        :label="field.title || key"
        :hint="field.description"
        persistent-hint
        type="number"
        density="comfortable"
        variant="outlined"
        class="mb-4"
        @update:model-value="v => (model[key] = v === '' ? null : Number(v))"
      />

      <!-- 嵌套对象：单独成块并递归 -->
      <v-card v-else-if="primaryType(field) === 'object'" variant="outlined" class="mb-4">
        <v-card-item>
          <template #title>
            <span class="text-body-2">{{ field.title || key }}</span>
          </template>
        </v-card-item>
        <v-card-text>
          <div v-if="field.description" class="text-caption text-medium-emphasis mb-3">
            {{ field.description }}
          </div>
          <SchemaForm
            :schema="field"
            :model="objectValue(key, field)"
            :read-only-keys="readOnlyKeys"
            :raw-keys="rawKeys"
            :depth="(depth ?? 0) + 1"
          />
        </v-card-text>
      </v-card>

      <!-- 字符串（password 只影响遮不遮） -->
      <v-textarea
        v-else-if="field['x-widget'] === 'textarea'"
        :model-value="valueOf(key, field)"
        :label="field.title || key"
        :hint="field.description"
        persistent-hint
        rows="2"
        density="comfortable"
        variant="outlined"
        class="mb-4"
        @update:model-value="v => (model[key] = v)"
      />

      <v-text-field
        v-else
        :model-value="valueOf(key, field)"
        :label="field.title || key"
        :hint="field.description"
        :type="field['x-widget'] === 'password' ? 'password' : 'text'"
        persistent-hint
        density="comfortable"
        variant="outlined"
        class="mb-4"
        @update:model-value="v => (model[key] = v)"
      />
    </template>
  </div>
</template>
