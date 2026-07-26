---
title: "ADR-001: Storage Truth Boundary"
status: accepted
decision_id: ADR-001
created: 2026-07-26
scope: sessions, messages, invocations, memory, transcripts, project knowledge, and search projections
supersedes: []
related:
  - ../memory-data-contract.md
---

# ADR-001：存储真相边界

## 1. 状态

**Accepted — implementation pending**

本 ADR 冻结 SHIFT 的目标存储边界。当前代码仍支持 `files / dual / sqlite`，默认运行在
`dual`；这是迁移现状，不是本文定义的终态。实现 PR 必须显式说明它推进了哪一条迁移
验收条件，不能在代码中重新发明另一套真相语义。

`docs/memory-data-contract.md` 继续作为记忆 schema、ownership、authority、purge 和
projection 细节的规范。本 ADR 负责更高一层的全系统边界；两者冲突时必须先修改并重新
评审文档，不允许实现自行选择。

## 2. 背景

SHIFT 最初以 JSON session 文件和 JSONL transcript 保存本地状态，随后引入 SQLite，
承载 thread、message、invocation、context window、memory 和 recall projection。为了
安全迁移和保留旧数据，当前系统同时存在：

- `sessions.json` 文件会话存储；
- 按 thread/invocation 组织的 JSONL transcript；
- SQLite durable tables；
- SQLite recall/FTS projections；
- `files / dual / sqlite` 三种在线模式；
- SQLite 与文件之间的合并读取、完整度比较和失败回退；
- session map、worktree state 等普通 JSON 运行文件。

这些机制在迁移阶段有价值，但如果长期将文件和 SQLite 视为同一业务实体的平级来源，
系统就无法稳定回答：

- 一条 message 以哪边为准；
- 删除后的 thread 是否可以被旧 transcript 复活；
- SQLite 与文件不一致时，哪一边代表用户当前看到的事实；
- 索引、摘要和记忆卡片是否可以反向覆盖原始证据；
- 数据库写入成功但 transcript 写入失败时，请求是否成功；
- 哪些知识应随 Git 项目传播，哪些只属于本机运行时。

本 ADR 的目标不是追求“所有数据只有一个物理文件”，而是确保：

> 每一个业务概念只有一个权威来源；其他表示必须是审计副本、派生投影或缓存。

## 3. 决策摘要

SHIFT 采用四类明确分工的持久化边界：

1. **SQLite 是唯一在线业务真相源。**
2. **Git 管理的项目文件是正式项目知识和项目内容的真相源。**
3. **JSONL 是追加式审计、诊断和灾难恢复材料，不参与正常在线仲裁。**
4. **普通 JSON 仅用于配置、迁移 checkpoint 或可重建的本机绑定；不得承载核心业务真相。**

Recall、FTS、passage、digest 和 usage summary 是派生读模型，可以从权威来源重建。

“唯一在线业务真相源”不表示 SQLite 拥有项目代码、Git worktree、Skill Markdown 或
Agent identity。SQLite 只保存这些外部真相源的引用、hash、索引和运行期绑定。

## 4. 真相源矩阵

| 概念                                    | 权威来源                         | 非权威表示                            |
| --------------------------------------- | -------------------------------- | ------------------------------------- |
| Thread 存在性、标题、项目绑定、归档状态 | SQLite `threads`                 | UI cache、导出 JSON                   |
| 正式用户/Agent 消息                     | SQLite `messages`                | JSONL audit、recall/FTS               |
| Invocation 生命周期和终态               | SQLite `invocations`             | JSONL audit、UI runtime               |
| 可回放的规范化 durable events           | SQLite invocation event tables   | canonical JSONL                       |
| Provider 原始事件                       | raw JSONL diagnostic log         | 不得成为 message/memory 真相          |
| Context window、generation、usage       | SQLite context/window tables     | usage summary                         |
| Provider resume session 绑定            | SQLite window/session binding    | legacy session-map JSON               |
| 未确认 suggestion 和运行期 memory       | SQLite memory tables             | Active Memory Card                    |
| 已确认但尚未 materialize 的产品记忆     | SQLite `memory_entries`          | recall projection                     |
| 已 materialize 的项目长期知识           | Git 管理的 Markdown/项目文件     | SQLite passage/index + source pointer |
| 记忆生命周期、authority、失效状态       | SQLite memory tables/events      | JSONL audit                           |
| 项目源码和配置内容                      | Git 工作区文件                   | SQLite evidence index                 |
| Worktree 实际存在性和内容               | Git                              | SQLite 中的 session 关联信息          |
| Agent identity                          | `src/agents/identities/*.md`     | 解析后的内存/API 数据                 |
| Skill 定义                              | `skills/*.md`                    | 解析后的内存/API 数据                 |
| Recall/FTS/passages                     | SQLite 派生投影                  | 可重建，不可反向成为真相              |
| Digest/summary/injection card           | SQLite 派生投影或运行时结果      | 导航信息，不是原始证据                |
| 环境配置                                | 进程环境、`.env`、明确的配置文件 | 进程内解析对象                        |

这里的“SQLite”表示逻辑数据库边界，不要求所有领域永远共用同一个 `.sqlite` 文件。
未来可以按领域拆分物理数据库，但每个概念仍只能有一个 owner。

## 5. SQLite 的职责

### 5.1 在线业务状态

正常运行时，下列 API 和服务只能以 SQLite 为准：

- session/thread list、get、create、update、archive/delete；
- message history；
- invocation list、detail、state；
- context window 和 usage；
- memory list、confirm、invalidate、supersede；
- recall/search 的 source rows 和派生投影；
- provider resume binding；
- 删除 guard、幂等键和因果关系。

在线请求不得扫描 `sessions.json` 或 transcript 后与 SQLite 合并，也不得通过
`eventCount`、更新时间或“哪边非空”猜测权威来源。

### 5.2 事务边界

需要保持一致的状态必须在同一个 SQLite 事务中提交。例如一次 Agent 正常完成至少包括：

1. 将 invocation 从 `running` 转为 terminal state；
2. 追加 `invocation-end` durable event；
3. 插入 `assistant-final` message；
4. 更新 thread 时间；
5. 更新必要的 source projection；
6. 插入待归档的 outbox 记录。

任何关键步骤失败时，整个事务回滚。不能留下“invocation 已完成但没有最终消息”或
“最终消息存在但 invocation 仍在运行”的半状态。

### 5.3 明确失败

目标 `sqlite` 模式采用 fail-closed：

- 数据库无法打开时，服务启动失败；
- 权威写入失败时，请求失败；
- 权威读取失败时返回 `degraded/unavailable`，不能把旧 JSON 文件伪装成当前结果；
- 派生投影失败可以在 source transaction 之外重试，但必须暴露健康状态；
- 非关键归档失败不能回滚已提交业务事务，但必须保留 outbox 并告警。

## 6. 文件真相源的职责

### 6.1 哪些内容应由 Git 文件拥有

以下长期知识在经过明确确认后，应优先 materialize 到项目现有的 Git 文件体系：

- 架构决策和 ADR；
- 项目级约束；
- API、数据和部署契约；
- 经验证、需要跨任务复用的技术事实；
- 重要故障教训和运行手册；
- Agent 协作规则和项目开发规范；
- 项目源码与配置本身。

SHIFT 优先发现并索引项目已有的 `AGENTS.md`、`README.md`、`CONTRIBUTING.md`、
`docs/**/*.md`、ADR/decision 目录。SHIFT 不得在未获用户许可时向任意项目自动创建
知识目录或修改文件。

### 6.2 Operational Memory 与 Institutional Knowledge

记忆分为两个生命周期层：

**Operational Memory**

- 当前/近期 thread 背景；
- handoff、window seal、会话摘要；
- 未确认 suggestion；
- 尚未证明需要跨机器传播的 fact/lesson；
- 用户或 Agent 的临时工作偏好。

它们由 SQLite 拥有，不自动进入 Git。

**Institutional Knowledge**

- 已拍板并应随项目传播的 decision/constraint；
- 经验证、长期有效的项目事实；
- 跨任务复用的 lesson/method；
- 正式契约、规范和运行手册。

它们只有经过用户批准的 materialization 后，才由 Git 文件拥有。

判断标准：

> 如果删除本机 SHIFT 数据库、换一台电脑或切换开发者后，这条知识仍应随项目存在，
> 它就应进入 Git 文件。

### 6.3 Materialization 边界

项目知识的目标生命周期是：

```text
conversation/evidence
  → SQLite suggestion
  → user confirmation
  → proposed Markdown patch
  → worktree diff / explicit approval
  → Git-managed file
  → SQLite reindex with source path + anchor + hash
```

Materialization 后：

- 文件内容是该项目知识的权威来源；
- SQLite 保存 source path、anchor、content hash、provenance 和检索 passage；
- 文件变化触发重新索引；
- 文件删除使投影失效；
- 旧投影不得静默重建或覆盖文件；
- SQLite 中不得保留一个可独立编辑、与文件平级竞争的第二份知识内容。

Materialization 的目录策略、Markdown schema 和审批 UI 由后续 ADR/spec 定义；本 ADR
只冻结“用户批准后文件成为权威”的边界。

## 7. JSONL 的职责

### 7.1 Canonical audit transcript

Canonical JSONL 保存带协议版本、稳定 event ID 和因果坐标的追加式事件，用于：

- 人工审计；
- invocation 过程下钻；
- 导出；
- SQLite 灾难恢复；
- replay 和 migration；
- 跨版本诊断。

它不得用于正常 session/message/recall API 的在线回退或合并读取。

### 7.2 Raw provider log

Raw JSONL 保存 Codex、Grok、OpenCode、Antigravity 等 provider 的原始协议输出：

- 只用于 adapter 调试和故障证据；
- 不保证跨 provider 或跨版本兼容；
- 必须有尺寸上限、敏感信息策略和保留期限；
- 不得直接产生正式 message 或 memory，必须先通过 canonical adapter；
- 默认可关闭，不能成为恢复正式业务状态的唯一材料。

### 7.3 审计不是在线真相

JSONL 证明“曾经发生过什么”，SQLite 表示“系统当前相信什么”。例如 JSONL 中存在旧
`memory-captured` 事件，不表示一个已经在 SQLite 中 `invalidated` 的 memory 仍然有效。

## 8. 普通 JSON 的职责

普通 JSON 可以用于：

- 明确的本机配置；
- migration checkpoint；
- crash-safe bootstrap hint；
- 可从 Git/SQLite/运行环境重新发现的绑定；
- legacy 数据导入。

普通 JSON 不得继续作为以下数据的终态存储：

- session/thread 列表；
- message history；
- invocation 生命周期；
- context window；
- 结构化长期 memory；
- 需要并发更新和事务一致性的状态。

`sessions.json` 和 legacy provider session map 属于迁移输入。迁移完成后，正常服务不应
依赖它们读取权威状态。

## 9. 派生投影

下列内容是 read model，而不是真相源：

- `recall_items`；
- FTS virtual tables；
- project passages；
- query terms、score、rank 和 quota 结果；
- digest 和 usage summary；
- Active Memory Card；
- embedding/vector index（未来）。

投影必须满足：

1. 可以从 source tables 或 Git 文件重建；
2. 有明确的 source kind、source ID、hash/version；
3. 投影损坏不能修改 source；
4. 重建不会复活已删除、已归档或已失效的 source；
5. 搜索结果能下钻到原始 message、event、memory 或文件 anchor；
6. 投影不可用时返回显式 availability，不把“不可用”伪装成“没有结果”。

## 10. SQLite 与 JSONL 的交付模型

SQLite 与文件系统不能共享真正的原子事务。终态使用 transactional outbox：

```text
SQLite transaction
  ├─ write authoritative business rows
  ├─ write authoritative durable event
  └─ insert outbox row
        ↓ COMMIT
outbox flusher
  ├─ append canonical JSONL
  └─ mark delivered / record retry
```

要求：

- outbox row 与业务状态同事务；
- JSONL append 具备稳定 event ID，可幂等重试；
- 进程重启后继续 flush；
- 归档失败不回滚已提交业务事务；
- 归档积压和最后错误必须可观测；
- 超过容量/时长阈值时向用户显示 degraded 状态；
- 禁止“先写两边，再用 try/catch 假装原子成功”。

Outbox 尚未实现。在引入 outbox 前，现有 `dual` 写入仅被视为迁移机制。

## 11. 读取、恢复和重建

### 11.1 正常读取

正常服务：

- 只读 SQLite source/read models；
- 项目知识通过 SQLite index 定位后，下钻到 Git 文件；
- 不读取 legacy session JSON 仲裁业务状态；
- 不读取 transcript 补齐正常 API 结果。

### 11.2 显式恢复

JSONL 只通过显式工具进入恢复流程：

```text
scan → validate protocol/checksum → deduplicate by stable ID
     → rebuild authoritative rows → apply tombstones
     → rebuild projections → integrity audit → recovery report
```

恢复必须：

- 幂等；
- 保持 thread、invocation 和 event 因果关系；
- 不覆盖更新版本的数据；
- 遵守 delete/purge tombstone；
- 输出 imported/skipped/conflicted/failed 统计；
- 完成后恢复为 SQLite-only 正常读取。

## 12. 删除、归档和隐私

- 普通“删除会话”默认遵循 Memory Data Contract 的 archive/purge 语义；
- 归档/删除必须写权威 SQLite 状态和 audit tombstone；
- replay 遇到 tombstone 不得复活旧数据；
- thread-owned memory 按 ownership 规则处理；
- project-owned institutional memory 不因 origin thread 归档而消失；
- 永久删除必须显式清理 SQLite、对应 transcript/raw-log 分区、outbox 和派生投影；
- JSONL 应按 thread/session/invocation 分区，以支持有边界的导出与永久删除；
- 删除工具必须输出删除范围和可恢复性。

## 13. Storage mode 生命周期

现有模式重新定义为：

| 模式     | 定位                                         | 终态               |
| -------- | -------------------------------------------- | ------------------ |
| `files`  | legacy compatibility、迁移测试、恢复工具输入 | 不作为正常产品模式 |
| `dual`   | 迁移观察期、差异审计                         | 临时               |
| `sqlite` | 正常在线业务模式                             | 唯一正式模式       |

Transcript 是否开启是独立维度，不应继续由 storage mode 隐式决定。目标配置语义类似：

```text
SHIFT_STORAGE_MODE=sqlite
SHIFT_AUDIT_TRANSCRIPT=on
SHIFT_RAW_EVENT_LOG=off
```

`dual` 退出条件：

1. legacy sessions/transcripts 已完成可重复迁移；
2. session/message/invocation/memory 数量与因果审计通过；
3. SQLite-only 路径覆盖正常 API；
4. transcript replay 可在空库恢复受支持的 canonical 数据；
5. tombstone 能阻止旧事件复活；
6. recall/FTS 可从 source 重建；
7. SQLite 失败和归档积压有可见健康状态；
8. outbox 已接管 canonical JSONL；
9. CI 不再依赖 online file fallback；
10. 至少一个发布周期的差异指标无未解释 divergence。

## 14. 当前实现差距

本 ADR 接受时已知的主要差距：

- `SHIFT_STORAGE_MODE` 默认仍为 `dual`；
- `session-read-service` 在非 sqlite 模式合并 SQLite 与文件会话；
- `recall-service` 在 dual/files 模式读取并合并 transcript；
- `event-store` 根据 storage mode 同步写 SQLite/transcript；
- `dual-write-recorder` 包含吞掉部分 SQLite 错误后继续运行的迁移语义；
- chat route 仍拥有多处按 `sqlitePrimary` 分支；
- session map/provider resume 仍有 legacy JSON 路径；
- outbox 和 archive backlog health 尚未实现；
- project-memory materialization workflow 尚未实现。

这些差距不是违反 ADR 的存量 bug；它们是后续迁移工作的明确清单。新增功能不得扩大
平级双源范围。

## 15. 实现顺序

1. 建立 storage audit 和 dual divergence 指标，不改变行为；
2. 为每个在线 API 标记 authoritative read path；
3. 增加 transactional outbox 和 archive health；
4. 将 session/message/invocation 正常读取切到 SQLite；
5. 将 recall/detail 正常读取切到 SQLite；
6. 保留并强化显式 migrate/recover/rebuild 工具；
7. 将 transcript 开关与 storage mode 解耦；
8. 将默认模式改为 `sqlite`；
9. 移除正常服务中的 file merge/fallback；
10. 在满足退出条件后删除 `dual` 产品模式，保留离线 legacy importer。

每一步都必须可以独立回滚，并在进入下一步前有数据审计证据。

## 16. 架构不变量

实现和测试必须长期保护以下不变量：

1. 每个业务概念只有一个 authoritative owner；
2. 正常 API 不通过比较两个存储来决定真相；
3. 投影可重建且不能反向覆盖 source；
4. archive/purge 后旧 JSONL 不能复活数据；
5. suggestions 在用户接受前不是项目事实；
6. materialized 项目知识以 Git 文件为准；
7. 项目文件修改必须经过明确授权并可查看 diff；
8. SQLite 权威写入失败必须对调用者可见；
9. JSONL 归档失败必须可重试、可观测；
10. 原始 provider 输出不能绕过 canonical protocol 写入正式业务表；
11. Git 拥有 worktree 内容，SHIFT 只拥有绑定；
12. availability 必须区分 empty、degraded 和 unavailable。

## 17. 后果

### 正面

- 正常读取和故障语义更容易解释；
- 删除、恢复和迁移不会互相复活数据；
- SQLite 事务真正保护 message/invocation/memory 一致性；
- JSONL 仍保留可审计、可导出和灾难恢复价值；
- 正式项目知识可以跟随 Git 分支、review 和跨机器传播；
- recall、摘要和未来 embedding 可以安全重建；
- 存储代码可以逐步删除 mode branch 和重复合并逻辑。

### 代价

- 需要 outbox、恢复工具和健康监控；
- legacy file 数据必须完成一次可审计迁移；
- materialization 需要审批、diff 和 source-hash 生命周期；
- SQLite 成为正式依赖，数据库故障不能再由旧文件静默掩盖；
- 永久删除必须同时处理数据库和审计归档；
- 迁移期间仍需维护有限时间的双路径测试。

## 18. 非目标

本 ADR 不决定：

- embedding/vector 引擎；
- 是否拆分多个 SQLite 文件；
- institutional knowledge 的固定 Markdown schema；
- 用户项目必须采用哪一种 docs 目录；
- 云端、多用户或跨设备同步；
- JSONL 的长期压缩格式；
- 具体备份产品 UX。

这些决策不得改变本文的 truth boundary；需要改变时必须用新的 ADR supersede 本文。
