# 阶段 5：持久化与配置

> 上游：[`04-message-adapter.md`](./04-message-adapter.md) · 下游：[`06-webui.md`](./06-webui.md)
> 参考实现：`astrbot/core/db/`（`po.py`、`migration/`、`vec_db/`）、`astrbot/core/backup/{exporter,importer}.py`、`astrbot/core/config/`

## 1. 目标

1. 配置有版本、可迁移、可回滚——升级不再依赖"用户自己改 yaml"；
2. 明确三类存储的边界，消除死依赖；
3. 提供结构化备份与恢复。

---

## 2. 现状盘点

| 存储 | 位置 | 实际用途 |
|---|---|---|
| **Redis** | `lib/config/redis.js`（会自动拉起 redis 进程，含 `aarch64` 分支） | 运行时 KV：消息去重（`lib/events/connect.js`）、计数（`lib/plugins/loader.js:523` 用 `redis.multi()`）、统计（`plugins/system/status.js`）、puppeteer `wsEndpoint` 跨进程共享（`renderers/puppeteer/lib/puppeteer.js:76`）、重启标记（`plugins/other/restart.js`） |
| **LevelDB** | `lib/util.js:183` 的 `Bot.getMap(dir)` | 插件侧的小型持久 Map（`set`/`delete` 自动落盘）。**仓库内无调用方**，是给第三方插件用的公开 API |
| **Sequelize** | `package.json` 依赖 + `config/default_config/db.yaml` | ⚠️ **全仓无任何 `import`**（仅 `db.yaml` 的注释提到）。`storage: data/db/data.db` 实际未被使用 |
| YAML 配置 | `config/default_config/*.yaml` → `config/config/*.yaml` | 用户配置 |
| 文件 | `data/`、`temp/` | 资源与临时渲染产物。`.gitignore` 中有 `/dump.rdb`，说明 redis 快照会落到仓库根目录 |

### 2.1 四个问题

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| 1 | **死依赖** | `sequelize` 与 `sqlite3` 在 `package.json` 中声明，代码里无 import | 安装体积与 `pnpm i` 时间白白增加；`db.yaml` 给了用户一个不存在的功能的错觉 |
| 2 | **配置无版本、无迁移** | `lib/config/config.js` 的 `initCfg()` 只做"`config/default_config/` 中缺哪个文件就从默认目录复制" | 键改名/删除/类型变化时，用户旧配置静默残留或与新代码冲突；没有任何提示 |
| 3 | **无备份/恢复** | 无相关代码 | 用户改坏配置后只能手工修；升级出问题无法快速回滚 |
| 4 | **三类存储边界不清** | redis 同时承担"1 秒去重"这类瞬时状态与"插件计数"这类长期数据 | 清 redis（常见运维动作）会连带清掉不该清的长期数据 |

---

## 3. 设计

### 3.1 配置版本化与幂等迁移

参考 AstrBot 的做法：不用重型迁移框架，用**幂等脚本 + 版本号**。

```
config/
├─ default_config/          # 出厂默认（随仓库版本变化）
├─ config/                  # 用户配置（.gitignore 中）
│  ├─ _meta.json            # { "config_version": 3, "updated_at": "..." }
│  └─ ...
└─ backups/                 # 迁移前自动备份（.gitignore 中）
   └─ 20260924-100943/
```

新增：

| 文件 | 职责 |
|---|---|
| `lib/config/version.js` | 读写 `_meta.json`，暴露 `CURRENT_CONFIG_VERSION` |
| `lib/config/migrate.js` | 扫描 `lib/config/migrations/*.js`，按版本号顺序执行缺失的迁移 |
| `lib/config/migrations/001-baseline.js` | 基线（仅确保 `_meta.json` 存在，写入当前版本） |
| `lib/config/backup.js` | 迁移前备份、备份列表、恢复 |

单个迁移的形态（幂等，重复执行无副作用）：

```js
export default {
  version: 2,
  description: "config/other.yaml 的 masterQQ 数组化",
  async up(dir) {
    const file = `${dir}/other.yaml`
    const cfg = YAML.parse(await fs.readFile(file, "utf8"))
    if (Array.isArray(cfg.masterQQ)) return       // 幂等：已迁移则直接返回
    cfg.masterQQ = [cfg.masterQQ].filter(Boolean)
    await fs.writeFile(file, YAML.stringify(cfg))
  },
}
```

启动顺序（在 `lib/config/config.js` 的 `initCfg()` 之后、插件加载之前）：

```
initCfg()                    # 补齐缺失的配置文件（现有行为）
  ↓
备份到 config/backups/<ts>/
  ↓
读 _meta.json → 执行缺失迁移（每个迁移独立 try/catch，失败则中止启动并提示恢复）
  ↓
写回 _meta.json
```

**关键约束**：迁移失败必须**中止启动并明确提示**，而不是继续。半迁移状态比不迁移更危险。

### 3.2 配置 schema 化

阶段 1 已经为**插件配置**引入 `config.schema.json`。本阶段把它推广到**宿主配置**：

- `config/default_config/*.yaml` 中的每一项，逐步补充到 `config/host.schema.js`（或 yaml 内的注释约定）；
- 目的不是重写配置系统，而是让 WebUI（阶段 6）能渲染表单并做校验；
- 顺带产出"用户配置与默认配置的差异报告"——这是排查配置类问题的第一手材料：`node . config:diff`。

### 3.3 存储边界（KISS，不引入新数据库）

| 数据类型 | 归属 | 理由 |
|---|---|---|
| 瞬时/可重建状态（1 秒去重、在线标记、重启标记） | Redis，并给键加明确前缀（如 `throttle:`） | 清了不影响正确性 |
| 长期计数与统计 | Redis，但**必须可重建**或加 `persist:` 前缀，并在 `.gitignore` 之外单独说明 | 现状混用 |
| 插件长期小型数据 | LevelDB（`Bot.getMap`） | 已有 API，无需改 |
| 关系型数据 | **目前无需求** | 不引入 |

对应动作：

- [x] 对 `sequelize` / `sqlite3` / `db.yaml` 做去留决策（见开放问题 Q1）
      —— **已决策（2026-09-24）：删除，但先进告警期。** 因为它是破坏性变更（BCR-0001），
      声明了这两个依赖的未知第三方插件会直接崩。已落地的告警手段：
      `lib/config/init.js` 的 `warnDeprecatedDeps()`（启动时打一次，只打一次——
      放在模块顶层会在单测里被刷屏）、`config/default_config/db.yaml` 的废弃头、
      `package.json` 的 `"//"` 注记。两个版本后按 BCR-0001 移除。；
- [ ] 为 redis 键建立前缀规范并写进 `AGENTS.md`，改造 `lib/plugins/loader.js`、`lib/events/connect.js`、`plugins/system/status.js` 中的现有键。

### 3.4 备份与恢复

参考 `astrbot/core/backup/exporter.py` 的关键决策：**导出为版本化的逻辑包，而不是裸拷数据库文件**。

```
backup-20260924-100943.zip
├─ manifest.json         # { format_version: 1, yunzai_version, config_version, created_at, entries: [...] }
├─ config/config/*.yaml
├─ data/                 # 排除 temp/ 与 logs/
└─ plugins.manifest.json # 插件清单（目录名 + plugin.json 元数据），不含 node_modules
```

CLI（挂在现有 `app.js` 的 `switch (process.argv[2])` 分支上，与 `stop`/`daemon`/`pm2` 风格一致）：

| 命令 | 行为 |
|---|---|
| `node . backup [--out <path>]` | 生成备份包 |
| `node . restore <file>` | 校验 `manifest.json` → 备份当前状态 → 解包 → 按 `config_version` 跑迁移 → 提示重启 |

**不备份** `node_modules`、`temp/`、`logs/`，也**不备份 redis**（其中的数据按 §3.3 定义为可重建）。

---

## 4. 兼容策略

- `config/default_config/*.yaml` 的文件名与结构**不重命名**，只做增量迁移；
- 用户手改的 yaml 若与默认结构不符，迁移脚本必须**保留未知键**（不做"白名单裁剪"），避免把用户插件自定义的配置段删掉；
- `db.yaml` 若决定删除，需提供迁移：把文件移入 `config/backups/` 而非直接删除，并在启动时输出一次提示。

---

## 5. 开放问题

| # | 问题 | 备选 | 倾向 |
|---|---|---|---|
| Q1 | `sequelize` / `sqlite3` / `db.yaml` 的去留 | ① 删除 ② 保留并标记为"插件可选依赖" ③ 真正启用 | **① 删除**。当前无需求，KISS；若将来需要关系型数据，再按届时的需求选型（AstrBot 用的是 SQLModel，不适合直接借鉴到 Node 侧）。删除前先 grep 确认第三方插件无 `Bot.sequelize` 之类依赖，并在 `99-compat` 中登记 |
| Q2 | 迁移脚本放 `lib/config/migrations/` 还是仓库根的 `migrations/` | — | **`lib/config/migrations/`**。与配置代码同域，避免根目录膨胀 |
| Q3 | 备份包格式 | ZIP / tar.gz | **ZIP**。Node 侧 `zlib` 原生支持 gzip，但 ZIP 的"可单独查看 manifest"对用户更友好；若嫌 ZIP 需要依赖，退化为 `tar.gz` + 单独的 `manifest.json` |
| Q4 | redis 键前缀是否需要一次性迁移 | — | **不需要**。redis 中的数据按 §3.3 定义为可重建，直接按新规范写新键，旧键等待自然过期 |

---

## 6. 验收标准

- [ ] `config/_meta.json` 在首次启动时生成，记录当前版本
- [ ] 至少 2 个真实迁移脚本落地（建议：`masterQQ` 数组化、某个已改名键的兼容），每个都有 `tests/fixtures/config/<version>/` 的历史快照测试
- [ ] 迁移是幂等的：连续执行两次结果一致，且第二次不产生文件变更
- [ ] 迁移前自动备份，备份目录可列出、可恢复
- [ ] 迁移失败时启动中止，错误信息包含"如何从备份恢复"的具体命令
- [ ] `node . backup` 生成的包能在干净目录中 `node . restore` 成功还原配置
- [ ] `node . config:diff` 输出用户配置与默认配置的差异
- [ ] `sequelize` 去留决策执行完毕（删除或明确标注），`pnpm i` 后依赖树中不再有未使用的重型包

---

## 7. 风险

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 迁移脚本写错，损坏用户配置 | 低 | **极高** | 迁移前强制备份；每个迁移必须有 fixture 测试；失败即中止启动 |
| 迁移"规范化"过度，删掉用户的未知键 | 中 | 高 | 明确规定：迁移只增改已知键，从不删除未知键 |
| 删除 `sequelize` 破坏未知的第三方插件 | 低 | 中 | 删除前 grep 确认；在 CHANGELOG 与 `99-compat` 中登记；保留一个版本的告警期 |
| 备份包过大（`data/` 可能很大） | 中 | 低 | 默认排除 `temp/`、`logs/`；提供 `--exclude-dir` 参数 |
| 配置 schema 化演变成重写配置系统 | 中 | 中 | 严格限定范围：只为 WebUI 提供描述，不改变配置读取路径与优先级 |
