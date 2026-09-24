# 事件样本（fixtures）

对应文档：`docs/refactor/02-pipeline.md` §7 第 0 步。

## 为什么是手工构造而不是录制真实流量

阶段 0 原计划录制真实消息作为"金标准"回归输入，最终改为手工构造，原因有三：

1. 本环境没有可用的平台账号，无法产生真实流量；
2. 需要覆盖的是**字段组合与边界**（`at` / `reply` / `file` / `json` / 未知段 / 禁言 / 黑名单 / 各 `post_type`），
   真实流量反而难以覆盖全，而边界恰恰是重构最容易改坏的地方；
3. 手工样本能进版本控制、能稳定复现，并在本文件中明确标注每条要验证的决策点。

## 格式

样本是**适配器载荷**（`Bot.em("<post_type>.<message_type>.<sub_type>", data)` 的 `data`），
因此只包含可序列化的字段——真实事件上的 `group` / `friend` / `member` 既有数据也有方法，
这里只写数据部分，方法由 `tests/helpers/events.js` 的 `makeEvent()` 补上。

```jsonc
{
  "post_type": "message",
  "message_type": "group",
  "sub_type": "normal",
  "self_id": 12345,          // 任意值都会在测试里用到，勿随意改动
  "user_id": 10001,
  "group_id": 67890,
  "message_id": 1000,
  "raw_message": "#复读",
  "message": [{ "type": "text", "text": "#复读" }],
  "sender": { "user_id": 10001, "nickname": "测试用户", "card": "测试用户" },
  "group": { "is_owner": false, "is_admin": false, "mute_left": 0, "all_muted": false }
}
```

`makeEvent()` 会补上：`group` / `friend` 的 `sendMsg` / `recallMsg` / `getMsg` / `pickMember`、
由 `group.pickMember(user_id)` 派生的 `member`、`adapter_id` / `adapter_name`，
以及一个**只记录不发送**的 `e.reply`（真实包装由 `PreProcessStage` 完成）。

## 样本清单

| 文件 | 覆盖的决策点 |
|---|---|
| `group-command.json` | 群聊命令命中 `rule`（`#复读`）——`ProcessStage` 应执行插件 |
| `group-no-match.json` | 群聊普通消息无插件命中——应走到"暂无插件处理" |
| `group-at-bot.json` | `at` 段且 `qq == self_id` → `atBot = true` |
| `group-alias-prefix.json` | 文本以 `botAlias`（默认 `云崽`/`云宝`）开头 → 剥离后 `hasAlias = true` |
| `group-multi-segment.json` | 文本 + `at`（非 bot）+ 图片：验证 `msg` / `at` / `img` 同时产出 |
| `group-image-only.json` | 纯图片消息：`msg` 为空、`img` 有值 |
| `group-reply-with-file.json` | `reply` + `file` 段：`reply_id` / `getReply` / `file` |
| `group-json-card.json` | `json` 段被序列化进 `msg` |
| `group-unsupported-segments.json` | `record` / `poke` 等**当前不被处理**的段类型——用于固定"不改变行为"的边界 |
| `group-muted.json` | 群全员禁言 + 成员非管理 → 限流检查的禁言早退 |
| `private-command.json` | 私聊：验证 `isPrivate` 的赋值时机（见 `02-pipeline.md` §2.2 约束 a） |
| `notice-group-increase.json` | `notice.group.increase`：验证 `post_type`/`notice_type` 的层级匹配 |
| `notice-group-decrease.json` | `notice.group.decrease` |
| `request-friend-add.json` | `request.friend.add`：**既不是群也不是私聊**，`isGroup`/`isPrivate` 都不赋值 |

## 扩展方式

新增一个 `.json` 即可，`tests/unit/pipeline/fixtures.test.js` 会自动校验其结构。
若要验证新的决策点，请同时在该文件与本表中说明它覆盖什么——否则半年后没人知道它为什么存在。
