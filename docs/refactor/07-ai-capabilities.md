# 阶段 7：AI 能力（按需）

> 上游：[`06-webui.md`](./06-webui.md) · 兼容登记：[`99-compat-and-migration.md`](./99-compat-and-migration.md)
> 参考实现：AstrBot `astrbot/core/{provider,agent,tools,skills,knowledge_base,computer}/`、`astr_main_agent.py`

## 1. 定位

本阶段**不是必经路径**，也不作为阶段 1-6 的前置。只有在出现明确需求（如接入 LLM 对话、记忆、知识库问答）时才启动。

本文档只做两件事：把 AstrBot 的对应实现定位到具体文件，标明哪些设计值得借鉴、哪些不要照搬。

## 2. 进入条件

- [ ] 阶段 1（插件契约）完成——Provider / 工具注册要复用其 schema 与元数据机制
- [ ] 阶段 2（流水线）完成——LLM 调用需要作为 `ProcessStage` 的一个分支，而不是塞进插件里
- [ ] 阶段 4（消息组件）完成——多模态输入输出需要 `Component` 模型
- [ ] 有一个具体的、可验收的需求（而不是"先把架构搭起来"）

---

## 3. 值得借鉴的四块

### 3.1 Provider 抽象与注册表

| AstrBot 文件 | 借鉴点 |
|---|---|
| `core/provider/provider.py` | 分层抽象：`AbstractProvider` → `Provider` / `STTProvider` / `TTSProvider` / `EmbeddingProvider` / `RerankProvider`。**按能力分接口**，而不是一个大而全的 provider |
| `core/provider/register.py` | `register_provider_adapter()` 装饰器把「类型名 → 实现类 + 元数据」登记进注册表，实例化由 `manager.py` 统一负责 |
| `core/provider/modalities.py` | `sanitize_contexts_by_modalities()` 按模型能力裁剪 image / audio / tool_use 内容。**这是多模态项目里最容易踩的坑，集中处理收益极大** |
| `core/provider/request_retry.py` | 重试策略独立成层，不散落在各 provider 里 |
| `core/provider/sources/` | 45+ 个实现的目录组织方式（一家一个文件），扩展成本低 |

对 Yunzai 的落点：新增 `lib/ai/provider/`，Provider 的配置声明复用阶段 1 的 `config.schema.json` 机制。

### 3.2 Agent 循环与工具调用

| AstrBot 文件 | 借鉴点 |
|---|---|
| `core/agent/runners/base.py` | `AgentState` 的 `step()` / `step_until_done()` 用异步生成器表达“一步一产出”的循环。这是**生成器本身的用法**，与已被否决的流水线洋葱模型无关（见 `02-pipeline.md` §3.2）；Node 侧可直接对应 |
| `core/agent/runners/tool_loop_agent_runner.py` | 工具循环的参考实现 |
| `core/agent/tool.py` | `FunctionTool` / `ToolSet`：工具的 schema 与执行分离 |
| `core/agent/tool_executor.py` | 执行期统一处理超时、异常、结果序列化 |
| `core/agent/mcp_client.py` | MCP 协议支持——若已有 MCP 生态（例如工作区里的 OpenViking），这是接入点 |
| `core/agent/context/{compressor,truncator,token_counter}` | 上下文治理独立成层：压缩、截断、token 计数 |
| `core/tools/registry.py` | 内置工具「模块元组 + 配置条件启用」的声明方式 |
| `core/skills/skill_manager.py` | `SKILL.md` 技能包（前置元数据 + 工作区路径）——与 VS Code Agent Skills 形态一致，可直接复用现成资产 |

**不要照搬**：`core/agent/handoff.py`（子代理转交）、`subagent_orchestrator.py`、`core/computer/`（沙箱 + CUA 工具）。前者复杂度高且收益依赖具体场景，后者是巨大的维护负担。

### 3.3 会话、人格与记忆

| AstrBot 文件 | 借鉴点 |
|---|---|
| `core/conversation_mgr.py` | **区分「会话」与「对话」**（会话 = `unified_msg_origin`，对话 = 会话内的一段上下文）；60 秒节流落库，避免每条消息都写盘 |
| `core/persona_mgr.py` | 人格 CRUD + 默认人格 + 与人设绑定的工具/技能 |
| `core/platform_message_history_mgr.py` | 把平台的 `MessageChain` 转成**平台无关、路径无关**的 JSON parts 落库。这是记忆能力的前提——直接存原始 segment 会导致换适配器后历史全废 |
| `astr_agent_context.py` | `ContextWrapper[TContext]` 泛型包装，让 Agent 层与平台层解耦（Node 侧不需要泛型体操，只需保证 Agent 层不 import 适配器） |

对 Yunzai 的落点：`umo`（阶段 4）是这里的天然键。会话/对话的存储可先落在 `Bot.getMap()`（LevelDB）或阶段 5 定义的存储层。

### 3.4 知识库与检索

| AstrBot 文件 | 借鉴点 |
|---|---|
| `core/knowledge_base/kb_mgr.py` | 知识库管理器 + **回调注册以级联清理**（删除知识库时清理引用它的会话配置） |
| `core/knowledge_base/chunking/recursive.py` | `RecursiveCharacterChunker` 分块 |
| `core/knowledge_base/parsers/` | pdf / epub / markitdown / url / text 的解析器分层 |
| `core/knowledge_base/retrieval/` | **混合检索**：`SparseRetriever`（分词 + BM25）+ 稠密向量 + `RankFusion` 融合 + rerank 精排。纯向量检索在中文短查询上效果明显更差 |
| `core/db/vec_db/base.py` | `BaseVecDB` 接口签名：`insert` / `insert_batch` / `retrieve(…, top_k, fetch_k, rerank, metadata_filters)` → `Result(similarity, data)` |

**不要照搬** `db/vec_db/faiss_impl/`：FAISS + SQLite 映射是 Python 生态的单机方案。Node 侧若需要向量检索，优先评估 `sqlite-vec` 或复用外部服务；接口签名可以借，实现不必。

---

## 4. 与已有资产的关系

工作区中已有 `astrbot-plugins/astrbot_plugin_openviking_memory/`，若目标是"给 Yunzai 加记忆/知识库"：

- **优先读 AstrBot 的** `conversation_mgr.py` + `platform_message_history_mgr.py` + `PersonaManager`，这三块定义了「记忆该以什么结构落库」；
- 该插件与 OpenViking MCP 更适合作为**外部记忆服务**对接，而不是把它的实现搬进 Yunzai 内核；
- 落库结构必须平台无关（见 §3.3 的最后一条），否则未来加适配器要重做。

---

## 5. 验收与风险

阶段 7 的验收标准应在需求明确后单独编写，不在此处预设。仅先固定三条约束：

1. **不改变阶段 1-6 已冻结的行为**：LLM 能力作为 `ProcessStage` 内的可选分支，未配置时完全不生效；
2. **不引入阶段 1-6 也需要的重型依赖**：AI 相关依赖放在独立的 optional 依赖组（`package.json` 的 `optionalDependencies` 或 `peerDependencies`），未安装时不影响启动；
3. **Provider 密钥不得进入 `config/config/`**：该目录被备份与 WebUI 读取，密钥应走环境变量或独立的 `config/secrets/`（需在阶段 5 的备份排除清单中）。

| 风险 | 影响 | 对策 |
|---|---|---|
| 范围失控（一次想做完 provider + agent + RAG + 沙箱） | 高 | 每次只做一个能力，且必须有独立可验收的需求 |
| 密钥泄漏进备份包或 WebUI | 高 | 独立的密钥存储路径 + 备份排除 + WebUI 默认脱敏 |
| 上下文治理缺失导致成本失控 | 高 | `token_counter` / `truncator` 必须在第一版就位，不能后补 |
| 平台相关结构写进长期存储 | 高 | 落库前强制经过平台无关的序列化层 |
