<script setup lang="ts">
import { computed, ref, watch } from "vue"
import {
  ApiError,
  getConfigFile,
  getConfigList,
  getConfigSchemas,
  putConfigFile,
} from "@/api/client"
import type { ConfigFile, ConfigFileStatus, ConfigWriteResult, SchemaField } from "@/api/types"
import ConfigValue from "@/components/ConfigValue.vue"
import PanelState from "@/components/PanelState.vue"
import SchemaForm from "@/components/SchemaForm.vue"
import { useAsync } from "@/composables/useAsync"
import { useAuthStore } from "@/stores/auth"

/**
 * 配置查看 + 编辑（阶段 6 v2）。
 *
 * # 界面必须跟着后端的三条硬约束走
 *
 * 1. **文件名只能来自清单**。`/config/{name}` 的白名单是 `^[\w.-]+\.ya?ml$`
 *    且要求 `basename` 等于原名，所以界面**不给**输入框，只让点清单里的项。
 * 2. **脱敏必须说明**。后端把密钥键整值换成 `***` 并在 `redacted` 里列出路径，
 *    界面必须显式说明"部分密钥未展示"（位置由 `ConfigValue` 就地标注）。
 * 3. **清单里的文件不等于有差异的文件**：后端自己列目录，所以与默认完全一致的
 *    文件也在清单里——否则它会凭空消失。
 *
 * # 编辑模式的两处关键设计
 *
 * ## ① 提交的是**增量**，不是整份配置
 *
 * 后端是逐个 `set`（保留注释、保留没提交的键），所以这里做一份"打开编辑时的快照"，
 * 保存时只把**值真的变了的键**发出去。否则每保存一次都会把表单里所有键重写一遍，
 * 而表单里有些键是"schema 默认值"而不是"用户文件里的值"——那等于用默认值
 * 覆盖用户的配置。这是这个界面最容易犯的错。
 *
 * ## ② `server.auth` / `server.https` 只能看不能改
 *
 * 后端按 BCR-0004 封死了它们（它们决定面板自己的门卫与监听）。界面必须跟着封：
 * 让用户填完再被 400 拒掉是最差的体验。所以这两个键渲染成禁用并写明原因，
 * 也**不会**出现在提交的增量里。
 */
const auth = useAuthStore()

const { data, error, loading, refresh } = useAsync(getConfigList)
const { data: schemaData } = useAsync(getConfigSchemas)

const selected = ref("")
const file = ref<ConfigFile | null>(null)
const fileError = ref("")
const fileLoading = ref(false)
/** 看用户侧还是出厂默认侧（只在查看模式有意义） */
const side = ref<"user" | "defaults">("user")

/** 是否处于编辑模式 */
const editing = ref(false)
/** 编辑中的值（就地改，SchemaForm 直接写它） */
const draft = ref<Record<string, unknown>>({})
/** 进入编辑时的快照，用来算增量 */
const original = ref<Record<string, unknown>>({})
/** 原始 yaml 文本（只读展示，也用于"这些键请在这里改"的提示） */
const rawText = ref("")

const saving = ref(false)
const saveError = ref("")
const saveResult = ref<ConfigWriteResult | null>(null)
/** 有改动但还没保存 */
const dirty = computed(() => changedEntries.value.length > 0)

/** 该文件的 schema（未建模或未选中时为 undefined） */
const schema = computed<SchemaField | undefined>(() =>
  selected.value ? schemaData.value?.schemas[selected.value] : undefined,
)

/** 该文件"明确不建模"的原因（不是漏了） */
const unmodeledReason = computed(
  () => schemaData.value?.unmodeled.find(item => item.name === selected.value)?.reason,
)

/**
 * 后端**写不进去**的键 → 原因。
 *
 * 与 `lib/web/api/config-write.js` 的 `SENSITIVE_KEYS` 对应。这里刻意写死而不是
 * 从接口读：这些键是"面板自己的门卫"，数量少且稳定，而多一个后端接口只为传它
 * 不值得。不变量由"后端拒绝了就是 400"兜底——即使这里漏写，也不会写坏东西。
 */
const readOnlyKeys = computed(() => {
  // 显式标注：直接 `return {}` 会让 TS 把两个分支统一成
  // `{ auth?: undefined; https?: undefined }`，与 Record<string,string> 不兼容
  const empty: Record<string, string> = {}
  if (selected.value !== "server.yaml") return empty
  return {
    auth: "面板不允许修改这个键：它决定面板自身的鉴权（BCR-0004）",
    https: "面板不允许修改这个键：它决定面板自身的监听与证书（BCR-0004）",
  } as Record<string, string>
})

/**
 * "面板不渲染成表单、请在 yaml 里改"的键 → 理由。
 *
 * 两类来源合成一份说明：
 *
 * 1. schema 标了 `x-widget: raw` 的（`auth`、`https`）——结构不适合表单：
 *    `auth` 是**任意键名**的映射，`https` 是"要么都填、要么都不填"的一组；
 * 2. 后端按 BCR-0004 **封死**的（恰好也是这两个）。
 *
 * 合成一份是刻意的。早先版本把 `raw` 与"禁用"做成两套渲染路径，
 * 而 `raw` 先命中 → **"为什么不能改"那句话永远显示不出来**，
 * 页面上只剩一句"请直接编辑"（实测发现的）。
 * 现在由这一份说明同时回答"为什么"和"去哪里改"。
 */
const rawReason = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {}
  for (const [key, field] of Object.entries(schema.value?.properties ?? {})) {
    if (field["x-widget"] !== "raw") continue
    result[key] = readOnlyKeys.value[key] ?? "结构不适合表单（键名不固定或多键联动）"
  }
  return result
})

/** 能通过表单改的顶层键：既不是 raw，也不是后端封死的 */
const editableKeys = computed(() =>
  Object.keys(schema.value?.properties ?? {}).filter(
    key => !rawReason.value[key] && !readOnlyKeys.value[key],
  ),
)

/** `rawReason` 的名字集合，给 `SchemaForm` 当"这些键跳过"的标记用 */
const rawKeysForForm = computed<Record<string, boolean>>(() => {
  const result: Record<string, boolean> = {}
  for (const key of Object.keys(rawReason.value)) result[key] = true
  return result
})

// 清单到手的默认选中：第一个文件。不自动选的话右侧永远空着，看不出这页能干什么。
watch(data, list => {
  if (!list?.files.length || selected.value) return
  selected.value = list.files[0].name
})

watch(selected, async name => {
  fileError.value = ""
  file.value = null
  editing.value = false
  saveError.value = ""
  saveResult.value = null
  if (!name) return

  fileLoading.value = true
  try {
    file.value = await getConfigFile(name)
    rawText.value = file.value.user === null ? "" : JSON.stringify(file.value.user, null, 2)
    // 只有一侧有值时直接切到有值的那侧，免得看到一个空的 `null`
    side.value = file.value.user === null && file.value.defaults !== null ? "defaults" : "user"
  } catch (err) {
    if (err instanceof ApiError) {
      fileError.value = err.message
      if (err.isUnauthorized) auth.promptForToken()
    } else {
      fileError.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    fileLoading.value = false
  }
})

/**
 * 深拷贝一份纯数据。
 *
 * 刻意**不用 `structuredClone`**：这里拷的是从 `ref` 里取出来的对象，
 * 而 `ref` 的深层值已经被 Vue 包成了响应式 Proxy，`structuredClone` 遇到
 * Proxy 会抛 `DataCloneError`（实测："could not be cloned"），
 * 于是整个编辑模式直接炸掉、表单一个字段都不渲染。
 *
 * 配置本来就是"从 JSON 来的纯数据"，用 JSON 往返最省事也最安全
 * （不会像 `structuredClone` 那样试图搬运不可克隆的内部结构）。
 *
 * @param value 任意值
 * @returns 深拷贝
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 构造编辑用的初值：以用户侧的值为主，缺失的键回落 schema 的 `default`。
 *
 * ⚠️ 回落的默认值**只是表单的显示值**，不是"用户文件里的值"。所以保存时靠
 * `changedEntries` 与快照对比，只提交真的被改过的键（见文件头的说明 ①）。
 *
 * @returns 表单初值
 */
function buildDraft(): Record<string, unknown> {
  const user = file.value?.user
  const base: Record<string, unknown> =
    user !== null && user !== undefined && typeof user === "object" && !Array.isArray(user)
      ? clone(user as Record<string, unknown>)
      : {}

  for (const [key, field] of Object.entries(schema.value?.properties ?? {})) {
    if (key in base) continue
    if ("default" in field) base[key] = clone(field.default)
    else if (field.properties) base[key] = {}
  }
  return base
}

function startEdit(): void {
  if (!schema.value) return
  draft.value = buildDraft()
  original.value = clone(draft.value)
  editing.value = true
  saveError.value = ""
  saveResult.value = null
}

function cancelEdit(): void {
  editing.value = false
  saveError.value = ""
  draft.value = {}
  original.value = {}
}

/**
 * 逐键找出真正改动过的键。
 *
 * 与 `original` 快照对比（而不是与文件比），因为表单里可能掺了 schema 默认值。
 *
 * @returns `[键, 新值]` 列表
 */
const changedEntries = computed<Array<[string, unknown]>>(() => {
  if (!editing.value) return []
  const out: Array<[string, unknown]> = []
  for (const key of editableKeys.value) {
    const before = original.value[key]
    const after = draft.value[key]
    // 深比较：嵌套对象（milky.webhook）改一个叶子也算改
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push([key, after])
  }
  return out
})

/** 改动的可读摘要，保存确认对话框里显示 */
const changeSummary = computed(() =>
  changedEntries.value.map(([key, value]) => ({
    key,
    from: JSON.stringify(original.value[key] ?? null),
    to: JSON.stringify(value ?? null),
  })),
)

/**
 * 重新拉一次当前文件。
 *
 * 保存成功后要刷新：脱敏后的展示值、以及左侧清单里的差异条数都会变。
 * 不重建 `selected`（那会连带清掉编辑状态），所以这里单独抽一个 loader——
 * 与 `watch(selected)` 里那段是同一件事，只是不切文件。
 *
 * @returns 无
 */
async function reloadFile(): Promise<void> {
  const name = selected.value
  if (!name) return
  fileLoading.value = true
  fileError.value = ""
  try {
    const fresh = await getConfigFile(name)
    // 期间用户可能又切了文件，别把别的文件的内容写进来
    if (selected.value !== name) return
    file.value = fresh
    rawText.value = fresh.user === null ? "" : JSON.stringify(fresh.user, null, 2)
  } catch (err) {
    if (err instanceof ApiError) fileError.value = err.message
    else fileError.value = err instanceof Error ? err.message : String(err)
  } finally {
    fileLoading.value = false
  }
}

async function save(): Promise<void> {
  if (!selected.value || !changedEntries.value.length) return
  saving.value = true
  saveError.value = ""
  try {
    const config: Record<string, unknown> = {}
    for (const [key, value] of changedEntries.value) config[key] = value
    saveResult.value = await putConfigFile(selected.value, config)

    // 保存成功即退出编辑态：快照与文件已经对齐，留在编辑态反而容易误以为"还没存"
    editing.value = false
    draft.value = {}
    original.value = {}
    await reloadFile()
    await refresh()
  } catch (err) {
    if (err instanceof ApiError) {
      saveError.value = err.message
      if (err.isUnauthorized) auth.promptForToken()
    } else {
      saveError.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    saving.value = false
  }
}

const STATUS_LABEL: Record<ConfigFileStatus, string> = {
  both: "两侧都有",
  "only-user": "仅用户侧",
  "only-default": "仅默认侧",
}

const STATUS_COLOR: Record<ConfigFileStatus, string> = {
  both: "success",
  "only-user": "warning",
  "only-default": "info",
}

function statusColor(status: ConfigFileStatus): string {
  return STATUS_COLOR[status] ?? "grey"
}

function statusLabel(status: ConfigFileStatus): string {
  return STATUS_LABEL[status] ?? status
}

/** 一个文件与默认的差异总数——用来决定要不要给这个文件一个醒目的标记 */
function diffCount(entry: {
  differences: { missing: number; extra: number; changed: number }
}): number {
  const d = entry.differences
  return d.missing + d.extra + d.changed
}

const currentSideLabel = computed(() =>
  side.value === "user" ? "用户配置（config/config）" : "出厂默认（config/default_config）",
)

const currentSideValue = computed(() => {
  if (!file.value) return undefined
  return side.value === "user" ? file.value.user : file.value.defaults
})
</script>

<template>
  <div>
    <div class="d-flex align-center flex-wrap ga-2 mb-4">
      <h2 class="text-h6">配置</h2>
      <v-chip v-if="data" size="small" variant="tonal">{{ data.files.length }} 个文件</v-chip>
      <v-spacer />
      <v-btn
        prepend-icon="mdi-refresh"
        variant="tonal"
        size="small"
        :loading="loading"
        @click="refresh()"
      >
        刷新
      </v-btn>
    </div>

    <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
      密钥键（<code>pass</code>/<code>secret</code>/<code>token</code>/<code>auth</code>/<code>credential</code>/<code>cookie</code>）
      的值由后端脱敏成 <code>***</code>，被遮的位置在下方就地标出。
      <strong>改动需要重启云崽才会生效</strong>（配置是启动期一次性读进内存的）。
    </v-alert>

    <PanelState
      :loading="loading"
      :error="error"
      :empty="!data?.files.length"
      empty-text="没有找到任何 yaml 配置文件"
      :on-retry="refresh"
    >
      <v-row v-if="data">
        <v-col cols="12" md="4" lg="3">
          <v-card variant="outlined">
            <v-card-item title="文件" prepend-icon="mdi-file-document-multiple-outline" />
            <v-divider />
            <v-list density="compact" nav>
              <v-list-item
                v-for="entry in data.files"
                :key="entry.name"
                :active="selected === entry.name"
                @click="selected = entry.name"
              >
                <v-list-item-title>
                  {{ entry.name }}
                  <v-icon
                    v-if="schemaData?.schemas[entry.name]"
                    size="x-small"
                    icon="mdi-form-select"
                    color="primary"
                    :title="'可以用表单编辑'"
                  />
                </v-list-item-title>
                <v-list-item-subtitle>
                  <v-chip
                    :color="statusColor(entry.status)"
                    size="x-small"
                    variant="tonal"
                    class="mr-1"
                  >
                    {{ statusLabel(entry.status) }}
                  </v-chip>
                  <span v-if="diffCount(entry)" class="text-caption">
                    差异 {{ diffCount(entry) }}
                  </span>
                  <span v-else class="text-caption text-medium-emphasis">与默认一致</span>
                </v-list-item-subtitle>
              </v-list-item>
            </v-list>
            <v-divider />
            <v-card-text class="text-caption text-medium-emphasis">
              <div>用户目录：<br />{{ data.dirs.config }}</div>
              <div class="mt-1">默认目录：<br />{{ data.dirs.defaults }}</div>
              <div class="mt-2 d-flex align-center">
                <v-icon size="x-small" icon="mdi-form-select" color="primary" class="mr-1" />
                可以用表单编辑
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <v-col cols="12" md="8" lg="9">
          <v-card variant="outlined" min-height="300">
            <v-card-item>
              <template #title>
                <span class="text-body-1">{{ selected || "未选择文件" }}</span>
              </template>
              <template #append>
                <div class="d-flex align-center ga-2">
                  <v-btn-toggle
                    v-if="!editing"
                    v-model="side"
                    density="compact"
                    variant="outlined"
                    divided
                    mandatory
                  >
                    <v-btn value="user" size="small">用户侧</v-btn>
                    <v-btn value="defaults" size="small">默认侧</v-btn>
                  </v-btn-toggle>
                  <v-btn
                    v-if="!editing && schema"
                    data-testid="config-edit"
                    color="primary"
                    variant="tonal"
                    size="small"
                    prepend-icon="mdi-pencil"
                    @click="startEdit()"
                  >
                    编辑
                  </v-btn>
                </div>
              </template>
            </v-card-item>
            <v-divider />

            <div v-if="fileLoading" class="d-flex justify-center pa-8">
              <v-progress-circular indeterminate color="primary" />
            </div>

            <v-alert v-else-if="fileError" type="error" variant="tonal" class="ma-4">
              {{ fileError }}
            </v-alert>

            <!-- ============ 编辑模式 ============ -->
            <template v-else-if="editing && file">
              <v-alert type="warning" variant="tonal" density="comfortable" class="ma-4">
                只提交<strong>改动过的键</strong>，文件里其他内容与你写的注释都原样保留。
                保存后需要重启云崽才会生效。
              </v-alert>

              <v-alert
                v-if="Object.keys(rawReason).length"
                data-testid="config-raw-notice"
                type="info"
                variant="tonal"
                density="comfortable"
                class="mx-4"
              >
                以下键面板不渲染成表单，请直接编辑
                <code>config/config/{{ selected }}</code
                >：
                <ul class="mt-1">
                  <li v-for="(reason, key) in rawReason" :key="key">
                    <code>{{ key }}</code> —— {{ reason }}
                  </li>
                </ul>
              </v-alert>

              <v-card-text>
                <SchemaForm
                  v-if="schema"
                  :schema="schema"
                  :model="draft"
                  :read-only-keys="readOnlyKeys"
                  :raw-keys="rawKeysForForm"
                />
                <div v-else class="text-medium-emphasis">
                  这个文件没有 schema（{{ unmodeledReason || "未建模" }}），只能直接编辑 yaml。
                </div>
              </v-card-text>

              <v-divider />
              <v-card-text>
                <div class="d-flex align-center flex-wrap ga-2 mb-3">
                  <strong class="text-body-2"> 改动 {{ changedEntries.length }} 项 </strong>
                  <v-chip
                    v-for="item in changeSummary"
                    :key="item.key"
                    size="x-small"
                    variant="tonal"
                  >
                    {{ item.key }}: {{ item.from }} → {{ item.to }}
                  </v-chip>
                  <v-spacer />
                  <v-btn variant="text" size="small" @click="cancelEdit()">取消</v-btn>
                  <v-btn
                    data-testid="config-save"
                    color="primary"
                    variant="flat"
                    size="small"
                    prepend-icon="mdi-content-save"
                    :disabled="!dirty"
                    :loading="saving"
                    @click="save()"
                  >
                    保存
                  </v-btn>
                </div>

                <v-alert v-if="saveError" type="error" variant="tonal" density="comfortable">
                  {{ saveError }}
                </v-alert>
              </v-card-text>
            </template>

            <!--
              保存结果**放在编辑块之外**：保存成功后会退出编辑态，写在里面的话
              这条提示会随着 `v-if="editing"` 一起消失——而"已写入 + 请重启"
              恰恰是保存后最需要看到的信息（实测踩过）。
            -->
            <v-card-text v-if="saveResult && !editing" data-testid="config-save-result">
              <v-alert type="success" variant="tonal" density="comfortable">
                已写入 {{ saveResult.name }}。
                <template v-if="saveResult.backup">
                  写前备份：<code>{{ saveResult.backup }}</code>
                </template>
                <template v-else>（原文件不存在，所以没有备份）</template>
                <br />
                <strong>请重启云崽让改动生效。</strong>
              </v-alert>
            </v-card-text>

            <!-- ============ 查看模式 ============ -->
            <template v-else-if="file">
              <v-alert
                v-if="file.redacted.length"
                type="warning"
                variant="tonal"
                density="comfortable"
                class="ma-4 mb-0"
              >
                有 {{ file.redacted.length }} 处密钥未展示（由后端脱敏）：
                <code>{{ file.redacted.join("、") }}</code>
              </v-alert>

              <v-alert
                v-if="selected && !schema"
                type="info"
                variant="tonal"
                density="comfortable"
                class="ma-4 mb-0"
              >
                这个文件只能直接编辑 <code>config/config/{{ selected }}</code
                >：{{ unmodeledReason || "未建模" }}
              </v-alert>

              <v-card-subtitle class="pt-4">{{ currentSideLabel }}</v-card-subtitle>
              <v-card-text>
                <div v-if="currentSideValue === null" class="text-medium-emphasis">
                  这个文件在{{ side === "user" ? "用户侧" : "默认侧" }}不存在（值为 null）。
                </div>
                <ConfigValue v-else :value="currentSideValue" :redacted="file.redacted" path="" />
              </v-card-text>
            </template>

            <v-card-text v-else class="text-medium-emphasis"> 从左侧选一个文件。 </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </PanelState>
  </div>
</template>
