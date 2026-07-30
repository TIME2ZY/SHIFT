# SHIFT Memory 数据契约

本文定义产品 Memory 的唯一有效模型。协作交接、窗口封存、摘要和恢复数据不属于
Memory；它们保存在 invocation events 或各自的恢复存储中。

## 1. 产品边界

Memory 只接受三种 `kind`：

- `decision`：已经拍板、后续工作应遵循的选择。
- `constraint`：必须满足或禁止违反的边界。
- `fact`：后续任务需要复用、且可明确核对的事实。

`lesson`、`handoff`、`window-seal`、`digest` 和 Suggestion 都不是产品 Memory。

Memory 只有两种状态：

- `active`：当前槽位的有效值。
- `superseded`：已被同槽位的新值替代，仅供审计追溯。

系统不提供 confirm、invalidate、accept 或 reject 状态。纠错必须写入同一槽位的新
Memory，由写入事务把旧值标记为 `superseded`。

## 2. 槽位与作用域

唯一槽位定义为：

```text
slot = scopeKey + topic
```

其中：

```text
thread scope  → scopeKey = thread:<ownerThreadId>
project scope → scopeKey = project:<projectKey>
```

同一 `topic` 可以在 thread 和 project 各有一个 active 值；两者不能互相替代。
替代只发生在完全相同的 `scopeKey + topic` 内，且不受 `kind` 变化影响。

默认作用域：

- `decision`、`constraint` → project；没有项目身份时降级为 thread。
- `fact` → thread。

调用方可以显式选择 thread/project，但 project 必须来自受信任 thread 的持久化项目
身份，不能由 MCP 参数伪造。

## 3. 写入协议

正式 Agent 写入口为 `memory_write`。服务端从已认证 invocation 绑定 thread、agent
和项目身份；客户端只提交产品内容：

```json
{
  "kind": "decision",
  "topic": "storage.authoritative",
  "content": "在线读写以 SQLite 为权威存储。",
  "scope": "project",
  "evidence": [{ "type": "message", "id": "message-id" }]
}
```

写入必须满足：

- `kind` 只能是 decision/constraint/fact。
- `topic` 必须规范化为稳定、可复用的键。
- `content` 必须是单一、明确、可独立理解的陈述。
- evidence 必须属于当前受信任 invocation/thread。
- authority、activation、createdBy、projectKey 和 ownerThreadId 由服务端派生。

返回结果：

- `created`：槽位首次写入。
- `unchanged`：槽位已有语义相同的 active 值。
- `superseded`：写入新值并替代旧值。
- `rejected`：输入或证据不满足契约。

不支持 MCP 的 Provider 可临时使用 deprecated `memory-upsert` callback；它必须完整
委托 `writeMemoryCandidate`，且不能扩大输入或状态语义。

## 4. 持久化约束

`memory_entries` 的产品字段包括：

```text
id
scope
owner_thread_id
origin_thread_id
project_key
topic
kind
status
content
authority
activation
created_by
created_at
superseded_by
metadata_json
```

数据库约束：

- `kind IN ('decision', 'constraint', 'fact')`
- `status IN ('active', 'superseded')`
- thread scope 必须有 `owner_thread_id`
- project scope 必须有 `project_key`
- 每个 thread `scopeKey + topic` 最多一个 active 值
- 每个 project `scopeKey + topic` 最多一个 active 值

旧的 captured/confirmed 数据迁移为 active；invalidated 和非产品 kind 进入
`legacy_memory_archive`，不再参与产品检索。

## 5. 检索与注入

普通检索和 Active Memory Card 默认只返回：

```text
kind ∈ {decision, constraint, fact}
status = active
scope 对当前 thread 可见
```

召回流程：

```text
每层 FTS 候选 + 每层 Vector 候选
→ RRF 融合
→ 业务重排
→ layer quota
→ final limit
```

FTS 保留 SQLite BM25 查询返回的顺序，并使用序号参与 RRF，不把 BM25 原始负数重新
映射为降序业务分数。向量不可用时必须降级到 FTS，不能让 Memory 查询整体失败。

注入内容始终是不可信历史数据：它不能覆盖用户最新指令，也不能被当作 system
instruction。

## 6. 向量生命周期

active Memory 可投影到 `embedding_items` 和当前 vec0 generation。发生 supersede 时：

1. 旧 Memory 的 embedding item 立即标记为 `stale`。
2. 从已加载的 vec0 表删除对应向量。
3. 扩展暂不可用时保留 stale 标记，并在运行时加载后执行清理。

模型或维度变化时应创建 building generation、回填权威数据、完成后原子切换 active，
再把旧 generation 标记为 retired。构建期间检索继续使用原 active generation。

## 7. 非 Memory 状态

- handoff：`handoff-captured` invocation event。
- window seal：`window-sealed` invocation event。
- digest：恢复摘要存储。
- Suggestion：已删除；不再生成、审核或注入。

这些状态不得写入 `memory_entries`，不得占用 Memory 检索配额，也不得出现在 Active
Memory Card。
