# dashboard/ —— Yunzai 运维面板前端

阶段 6 的 WebUI 前端。**v1 只读 + v2 配置编辑都已落地**：

| 页面 | 数据源 | 实现 |
|---|---|---|
| 状态总览 | `GET /api/v1/status`（`/ready` 作启动探针） | `src/views/StatusView.vue` |
| 插件列表 | `GET /api/v1/plugins` | `src/views/PluginsView.vue` |
| 配置查看 / 编辑 | `GET /api/v1/config`、`/config/{name}`、`/config/schemas`、`PUT /config/{name}` | `src/views/ConfigView.vue` + `src/components/SchemaForm.vue` |
| 实时日志 | `GET /api/v1/logs`（SSE） | `src/views/LogsView.vue` |

契约是 [`../docs/openapi.yaml`](../docs/openapi.yaml)，后端实现在 `../lib/web/`，
设计取舍与边界见 [`../docs/refactor/06-webui.md`](../docs/refactor/06-webui.md)。

## 配置编辑（v2）的三条须知

1. **只提交改动过的键**。页面进入编辑时存一份快照，保存时只发真正变了的键。
   必须这样：表单里的值掺了 schema 的 `default`（用户文件里其实没有那个键），
   整体提交等于**用默认值覆盖用户配置**。
2. **`server.auth` 与 `server.https` 面板改不了**（后端按 BCR-0004 封死）。
   它们决定面板自己的门禁与监听——面板不该有能力削弱自己的门卫。
   要改就直接编辑 yaml。
3. **改完要重启云崽才生效**。配置是启动期一次性读进内存的，写盘不影响正在跑的进程。
   写前会自动备份到 `config/backups/pre-write-<时间戳>-<原名>`。

## 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 框架 | Vue 3.5 + Vite 6 | 与参考实现（AstrBot `dashboard/`）一致，经验可复用 |
| UI | Vuetify 3.13 + MDI（`@mdi/js`） | 表单/表格密集的管理界面收益明显 |
| 状态 | Pinia 2 | 只有 `src/stores/auth.ts` 一个 store |
| 路由 | vue-router 4（**hash 模式**） | 理由见下 |
| API 客户端 | **手写 `fetch`**（`src/api/`） | 见下 |

**hash 路由不是随意选的**：面板挂在 `/dashboard` 前缀下，而宿主的 express 没有
（也不该有）给这个前缀注册「未命中就回 index.html」的兜底。history 模式下刷新
`/dashboard/plugins` 会直接 404。hash 模式永远只请求 `/dashboard/` 一个入口。

**为什么手写 API 客户端、不引 `@hey-api/openapi-ts`**：v1 只有 5 个 `GET`，
而契约↔实现这一侧已经由 `../tests/unit/web/openapi.test.js` 守着（它对着真实路由与
真实响应体双向比对，"生成 + git diff"防不住这一侧）。
`src/api/types.ts` 是 `docs/openapi.yaml` 的**手写镜像**——
**后端加了字段必须同步它**，漏了不会让 CI 变红，只表现为「界面少了一列」。

**图标为什么用 `@mdi/js` 而不是 `@mdi/font`**：后者是一份完整字体，
实测 3.4MB 且**全部**会进产物（Vuetify 的 `mdi` 图标集用 CSS 类名取字形，
bundler 判断不出哪些被用到）；前者按路径导出，只有 `src/plugins/vuetify.ts` 里
显式 import 的才进产物。代价是**新增图标要往那张表里补一行**，漏了那个位置会空着
（Vuetify 会打 `Could not find aliased icon`），但不报错。

## 装与构建

前端依赖**不在仓库根的 `pnpm install` 里**（根依赖表与它无关，见 `package.json` 的 `//` 说明）：

```bash
# 装依赖（dashboard/ 已是 pnpm workspace 成员，见 ../pnpm-workspace.yaml）
pnpm -C dashboard install

# 类型检查 + 构建到 dashboard/dist/
pnpm -C dashboard build

# 只做类型检查
pnpm -C dashboard typecheck
```

> `dist/` 与 `node_modules/` 都在 `.gitignore` 里。
> 与 AstrBot 不同：那边要把 dist 打进 Python 包，Node 侧由使用方自己构建。

## 开发联调

```bash
pnpm -C dashboard dev     # http://127.0.0.1:5273
```

Vite 会把 `/api` 代理到 `http://127.0.0.1:2536`（宿主默认端口，见
`config/config/server.yaml`）。代理**不注入令牌**——令牌由浏览器里的面板自己带着走，
写在 vite 配置里等于进仓库与访问日志。

联调前宿主侧要满足两件事：

1. `config/config/server.yaml` 里 `webui.enable: true`；
2. 同一个文件里配置了非空的 `server.auth`（键名 = 请求头名，例如
   `Authorization: Bearer <长随机串>`）。

两件都满足后重启云崽，日志里会出现
`[MARK][WebUI] WebUI 已挂载：/dashboard 与 /api/v1`。然后打开面板，
点右上角「未配置令牌」填入**头名与令牌**（两个都要填——头名是部署相关的，
只有默认配置才恰好叫 `Authorization`）。

> **为什么浏览器开面板不需要令牌，而 API 需要**：入口文档与 `/dashboard/assets`
> 是免鉴权的（浏览器给文档/脚本请求带不了自定义头），而 `/api/v1/*`
> 一律要令牌。这个放宽登记在 `../docs/refactor/99-compat-and-migration.md` 的 BCR-0002。

## 指向后端

生产路径是「同一台机器、同一个端口」：宿主自己托管 `dist/`，
所以页面里的请求一律打到**相对路径** `/api/v1`，不需要配置后端地址。

## 已知约束（写错了表现都是「连上了但看不到东西」）

- **SSE 必须实时**：后端响应头已带 `Cache-Control: no-transform`（宿主的
  `compression()` 会把小分片攒在缓冲区里，而 SSE 全是小分片）。自己再套反向代理时
  必须关掉对 `text/event-stream` 的缓冲。
- **心跳是「连接还活着」的唯一信号**：服务端每 15 秒发一行 `: ping`。
  连着两个周期没收到，`LogsView` 会自动重连，界面上也会显示「心跳超时」。
- **日志流用 `fetch` 而不是 `EventSource`**：后者不能带自定义请求头，而令牌恰恰要放在头里。
- **配置值已经脱敏**：`***` 是后端遮的，`redacted` 给出被遮的路径。
  界面上必须显式说明「部分密钥未展示」（`ConfigValue.vue` 就地标注）。
- **配置文件名只能来自清单**：`/config/{name}` 的白名单是 `^[\w.-]+\.ya?ml$`
  且 `basename` 必须等于原名，自己拼路径只会拿到 400。
- **插件列表的顺序就是执行顺序**（按 `priority` 升序）：界面**不重排**，
  那会丢掉唯一的信息量；`priority` 可能是 `null`（没声明，实际顺序由数组下标表达）。
- **启动期**：`/dashboard` 会收到 `503` + `Retry-After: 2`，`StatusView` 据此重试，
  而不是显示一个红色错误。
- **新字段要先改契约**：`../tests/unit/web/openapi.test.js` 会对真实响应体做双向比对。
  前端这边是手写类型（`src/api/types.ts`），**加了字段要同步那里**——
  漏了不会让 CI 变红，只会表现为「界面少了一列」。

## 待办（阶段 6 的 v2/v3）

- **v2 配置编辑**：表单由 schema 渲染，写入前后走同一个同构校验器
  （阶段 1 的 `lib/plugins/schema.js`）。与阶段 5 遗留的
  「宿主配置 schema 化」一起做。
- **v3 插件页面**：插件自带 `pages/`，受限 iframe + 插件用 `Bot.express` 注册自有 API。
- 敏感接口（重启、更新）落地时，要在对应子路径上再叠一层更紧的限流桶与二次确认字段
  （`06-webui.md` §5 里那条未勾选的验收项）。
