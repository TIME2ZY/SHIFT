---
title: "ADR-001: Storage Truth Boundary"
status: accepted
decision_id: ADR-001
created: 2026-07-26
amended: 2026-08-12
scope: sessions, messages, invocations, handoffs, traces, memory, transcripts, project knowledge, and search projections
supersedes: []
related:
  - ../memory-data-contract.md
  - 002-multi-agent-reliability-contracts.md
  - 006-project-first-runtime-home.md
---

# ADR-001：存储真相边界

## 1. 状态

**Accepted — SQLite cutover and runtime-home amendment implemented**

本 ADR 冻结 SHIFT 的目标存储边界。SQLite 唯一真相源切换、恢复验收、fixture 隔离、
真实 legacy 数据清理和在线兼容模式退役均已完成。产品 composition root 只接受 SQLite；
thread/message/invocation、provider resume、memory 和 recall 均不再读写 legacy 文件。
`files/dual` 只作为历史术语存在于离线 migrate、divergence audit 和脱敏 fixture 中。

`docs/memory-data-contract.md` 继续作为记忆 schema、ownership、authority、purge 和
projection 细节的规范。本 ADR 负责更高一层的全系统边界；两者冲突时必须先修改并重新
评审文档，不允许实现自行选择。

2026-08-12 增补的 Trace/Handoff 权威边界已经实现：Handoff accept、enqueue confirmation、
target bind 与 terminal 均由 SQLite repository 仲裁，启动 reconcile 收口遗留状态。当前代码
锚点以 `docs/architecture-map.md` 为准；不得重新引入进程内 route registry 作为平级真相源。

## 2. 背景

SHIFT 最初以 JSON session 文件和 JSONL transcript 保存本地状态，随后引入 SQLite，
承载 thread、message、invocation、context window、memory 和 recall projection。在架构
演进和新旧实现验证期间，代码与运行数据曾同时存在：

- `sessions.json` 文件会话存储；
- 按 thread/invocation 组织的 JSONL transcript；
- SQLite durable tables；
- SQLite recall/FTS projections；
- `files / dual / sqlite` 三种在线模式；
- SQLite 与文件之间的合并读取、完整度比较和失败回退；
- session map、worktree state 等普通 JSON 运行文件。

这些机制在切换验证阶段有价值，但如果长期将文件和 SQLite 视为同一业务实体的平级来源，
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
3. **JSONL 是追加式审计、诊断和导出材料，不参与正常在线仲裁或业务恢复。**
4. **普通 JSON 仅用于配置、迁移 checkpoint 或可重建的本机绑定；不得承载核心业务真相。**
5. **现有 legacy 运行数据不迁移到新存储 epoch；它只作为临时验证语料，切换验收后清除。**
6. **正式在线数据库的唯一物理位置是 `SHIFT_HOME/data/shift.sqlite`。**

Recall、FTS、passage、digest 和 usage summary 是派生读模型，可以从权威来源重建。

“唯一在线业务真相源”不表示 SQLite 拥有项目代码、Git worktree、Skill Markdown 或
Agent identity。SQLite 只保存这些外部真相源的引用、hash、索引和运行期绑定。

## 4. 真相源矩阵

| 概念                                    | 权威来源                         | 非权威表示                            |
| --------------------------------------- | -------------------------------- | ------------------------------------- |
| Project 存在性、目录绑定和归档状态      | SQLite `projects`                | UI 当前选择、最近项目缓存             |
| Thread 存在性、标题、项目绑定、归档状态 | SQLite `threads`                 | UI cache、导出 JSON                   |
| 正式用户/Agent 消息                     | SQLite `messages`                | JSONL audit、recall/FTS               |
| Chat request/Trace 生命周期（0B 目标）  | SQLite trace source tables       | Trace read model、UI runtime          |
| Invocation 生命周期和终态               | SQLite `invocations`             | JSONL audit、UI runtime               |
| Handoff 路由、绑定和终态（0B 目标）     | SQLite handoff source tables     | Trace read model、进程内 cache        |
| 可回放的规范化 durable events           | SQLite invocation event tables   | canonical JSONL                       |
| Provider 原始事件                       | raw JSONL diagnostic log         | 不得成为 message/memory 真相          |
| Context window、generation、usage       | SQLite context/window tables     | usage summary                         |
| Provider resume session 绑定            | SQLite window/session binding    | 脱敏 legacy session-map 测试 fixture  |
| 未确认 suggestion 和运行期 memory       | SQLite memory tables             | Active Memory Card                    |
| 已确认但尚未 materialize 的产品记忆     | SQLite `memory_entries`          | recall projection                     |
| 已 materialize 的项目长期知识           | Git 管理的 Markdown/项目文件     | SQLite passage/index + source pointer |
| 记忆生命周期、authority、失效状态       | SQLite memory tables/events      | JSONL audit                           |
| 项目源码和配置内容                      | Git 工作区文件                   | SQLite evidence index                 |
| Worktree 实际存在性和内容               | Git                              | SQLite 中的 session 关联信息          |
| Agent identity                          | `src/agents/identities/*.md`     | 解析后的内存/API 数据                 |
| Skill 定义                              | `skills/*.md`                    | 解析后的内存/API 数据                 |
| Recall/FTS/passages                     | SQLite 派生投影                  | 可重建，不可反向成为真相              |
| Trace spans、links、聚合指标            | SQLite 派生投影                  | 可重建，不可反向成为业务状态          |
| Digest/summary/injection card           | SQLite 派生投影或运行时结果      | 导航信息，不是原始证据                |
| 环境配置                                | 进程环境、`.env`、明确的配置文件 | 进程内解析对象                        |

当前产品的“SQLite”同时表示逻辑数据库边界和一个正式物理数据库：
`SHIFT_HOME/data/shift.sqlite`。不得按 Project 创建平行数据库，也不得让在线服务通过另一
环境变量选择任意业务数据库。未来若按领域拆分物理数据库，必须先提交新的 ADR，且每个概念
仍只能有一个 owner。

## 5. SQLite 的职责

### 5.1 在线业务状态

正常运行时，下列 API 和服务只能以 SQLite 为准：

- session/thread list、get、create、update、archive/delete；
- message history；
- chat request/trace 生命周期；
- invocation list、detail、state；
- handoff route、target binding、terminal outcome 和幂等键；
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

### 5.4 用户级运行目录

`SHIFT_HOME` 表示 SHIFT 的用户级应用根目录；未设置时为 `os.homedir()/.shift`。本 ADR
冻结的在线运行数据目录为：

```text
SHIFT_HOME/
└─ data/
   ├─ shift.sqlite
   ├─ shift.sqlite-wal
   ├─ shift.sqlite-shm
   ├─ audit-transcripts/
   ├─ raw-events/
   ├─ worktrees.json
   ├─ migration/
   └─ backups/
```

`SHIFT_HOME` 可以由进程环境或仓库本机 `.env` 提供；`.env` 不进入 Git，只提交
`.env.example`。在线 composition root 必须先加载环境，再一次性解析所有运行路径。数据库、
canonical audit、raw events 和 worktree 绑定状态均从 `SHIFT_HOME/data` 派生，不能各自
保留第二个在线路径开关。

仓库内旧 `data/runtime/shift.sqlite` 只允许由一次性离线迁移工具读取。迁移通过 SQLite
一致性 backup、权威表指纹、foreign key 和 integrity 校验后，原子发布到新位置。在线服务
从切换提交开始不得导入旧路径、探测旧库、双读、合并或失败回退；新库缺失或无效时启动
失败。离线审计和恢复工具仍可通过显式 `--db` 读取用户指定的备份文件。

本次迁移的现有业务数据均属于 SHIFT 仓库项目。迁移工具必须验证这一前提：空项目绑定可
补为 SHIFT 项目；规范路径指向其他项目的 Thread 必须令迁移失败，不能自动合并为 SHIFT。

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
- SQLite backup 恢复后的审计核对和诊断；
- 离线协议回放和兼容性测试；
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

Trace 与审计也不是同一概念：Trace 是面向定位和分析的可查询因果投影，可以重建、采样或
按保留策略删除 payload；canonical audit 是从权威事务 outbox 生成的追加式历史记录。
Trace 不得反向修正业务状态，audit 也不得作为在线 trace/handoff 恢复来源。

## 8. 普通 JSON 的职责

普通 JSON 可以用于：

- 明确的本机配置；
- migration checkpoint；
- crash-safe bootstrap hint；
- 可从 Git/SQLite/运行环境重新发现的绑定；
- 隔离环境中的兼容性测试 fixture。

普通 JSON 不得继续作为以下数据的终态存储：

- session/thread 列表；
- message history；
- invocation 生命周期；
- context window；
- 结构化长期 memory；
- 需要并发更新和事务一致性的状态。

`sessions.json`、legacy provider session map 和旧 transcript 不作为生产迁移输入。
切换期间它们保持只读，仅用于验证字段映射和新旧行为差异；正常服务不依赖它们，真实
历史数据已按 §12.1 清除。确需覆盖 legacy 格式时，只保留最小化、脱敏的测试 fixture。

## 9. 派生投影

下列内容是 read model，而不是真相源：

- `recall_items`；
- FTS virtual tables；
- project passages；
- query terms、score、rank 和 quota 结果；
- digest 和 usage summary；
- Active Memory Card；
- embedding/vector index（未来）。
- trace spans、span links 和时间窗口聚合指标。

Trace 投影只能组合已有权威事实和明确标注为 best-effort 的诊断事实。SSE、进程内计数器、
raw provider log 或写入完整度未知的 telemetry 不得单独作为成功率分母。指标必须同时暴露
样本资格与数据完整度，不能把 `unavailable`、`pending` 或 `unknown` 静默归为失败或空结果。

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
  ├─ append canonical JSONL to an epoch-safe audit directory
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

Outbox 的 SQLite 入队、幂等 JSONL flusher、重试、产品 API/UI health 和 delivered row
保留清理已实现。SQLite canonical archive 使用独立的
`audit-transcripts/<epoch-id>/`，不得与 legacy `transcripts/` 共用清理边界。现有
`dual` 写入只存在于待移除的兼容分支，不属于受支持的产品写入路径。

## 11. 读取、恢复和重建

### 11.1 正常读取

正常服务：

- 只读 SQLite source/read models；
- 项目知识通过 SQLite index 定位后，下钻到 Git 文件；
- 不读取 legacy session JSON 仲裁业务状态；
- 不读取 transcript 补齐正常 API 结果。

### 11.2 显式恢复

SQLite 备份是权威数据的恢复来源。恢复流程为：

```text
SQLite backup → restore into empty directory → integrity/foreign-key audit
              → rebuild derived projections → storage audit → recovery report
```

恢复必须保持 storage epoch、thread、message、invocation、memory 及其因果关系，并在完成后
恢复为 SQLite-only 正常读取。recall、FTS、digest 和 memory search 从恢复后的 SQLite
source tables 重建。

第五阶段 B 已于 2026-07-26 对 active clean epoch 完成一次真实空目录恢复验收。验收工具
逐表比较权威 source rows 的行数与确定性内容指纹，检查 foreign key、跨 thread 因果关系
和 sequence counter，重建 recall/FTS、memory search/FTS 与 digest，并用恢复库在随机
端口启动 SQLite-only 产品服务验证 health、session、message 和 memory/context API。
结果为 0 source mismatch、0 causality violation、0 audit error/warning，且未创建 legacy
session/invocation/session-map。摘要见
`docs/acceptance/005b-sqlite-recovery-20260726.md`。

Canonical JSONL 只承担审计归档、诊断和显式导出，不是会话真相源，也不承诺恢复完整
thread/message/invocation。任何 JSONL 工具都不得反向覆盖 SQLite 或绕过 tombstone。

## 12. 删除、归档和隐私

- 普通“删除会话”默认遵循 Memory Data Contract 的 archive/purge 语义；
- 归档/删除必须写权威 SQLite 状态和 audit tombstone；
- replay 遇到 tombstone 不得复活旧数据；
- thread-owned memory 按 ownership 规则处理；
- project-owned institutional memory 不因 origin thread 归档而消失；
- 永久删除必须显式清理 SQLite、对应 transcript/raw-log 分区、outbox 和派生投影；
- JSONL 应按 thread/session/invocation 分区，以支持有边界的导出与永久删除；
- 删除工具必须输出删除范围和可恢复性。

### 12.1 Legacy 数据断代清理

本次存储重构采用 clean cutover，不迁移切换前的 session、message、invocation、memory
或 transcript。新系统必须写入明确的 storage epoch（至少包含稳定 epoch ID、schema
version 和 cutover time）；epoch 之前的数据不承诺在线查询和恢复。

旧数据在验收前只作为只读验证语料，不允许被在线 API 合并、回退或写回。清除门槛为：

1. 新写入和正常读取均以 SQLite 为唯一来源；
2. 进程重启后 source tables 保持完整；
3. recall、FTS、digest 和 memory search 可从新 epoch 的 source 重建；
4. SQLite 备份、空目录恢复、投影重建和完整性检查完成一次演练；
5. canonical JSONL outbox 可重试，失败状态可观测；
6. CI 和本机验证所需的 legacy 场景已转换为最小化、脱敏 fixture；
7. 已生成清理清单，列出路径、数据范围、cutover time 和不可恢复性。

第五阶段 C 已于 2026-07-26 将必要 legacy 格式收敛为
`tests/fixtures/legacy-runtime/` 下的最小脱敏 fixture，覆盖 session/message、
invocation registry、transcript JSONL 和 provider session map。迁移测试只操作复制到系统
临时目录的 fixture；`npm test` 在执行前拒绝直接 runtime 路径、默认 runtime 存储常量和
未隔离的 `createServer()`。因此 CI 与本机测试不再依赖真实 legacy 历史。验收摘要见
`docs/acceptance/005c-legacy-fixture-isolation-20260726.md`。

清理工具必须从权威 `shift.sqlite` 读取 clean epoch/cutover，同时将 legacy
`memory.sqlite` 作为独立候选。若 legacy transcript 目录中检测到 post-cutover canonical
event，或任何候选路径与权威数据库/canonical audit 目录重叠，必须拒绝生成清理清单。
权威数据库的 `-wal` / `-shm` sidecar 与主文件具有相同保护级别。清理 CLI 必须和正常
服务共同加载 `.env` / `.env.local` 的 `SHIFT_*` 路径，显式 CLI 参数优先。epoch archive
目录只接受安全单段 ID，并显式拒绝 `.` / `..` 后再校验 containment。

满足门槛后，可以直接永久删除旧 `sessions.json`、旧 transcript、旧 provider session map
及其旧投影，无需先导入 SQLite。清理操作必须是独立、显式的变更，不得夹带在 schema
migration 或服务启动逻辑中。最终只保留脱敏 fixture、差异审计摘要和清理记录，不保留
真实历史业务内容。

第五阶段 D 已于 2026-07-26 完成。旧 transcript 中混入的 161 条 canonical
event 已通过 SQLite outbox 校验并幂等补入 active epoch 的受保护 audit archive，覆盖率
为 161/161。version 2 清理清单为七个 legacy 目标记录内容指纹；执行器重新核对 epoch、
固定路径 allowlist、目标指纹和 archive coverage，并要求精确 confirmation token 与
`--apply`。收到明确确认后，旧 session、invocation、transcript、provider session map 和
legacy validation SQLite 共 378 个文件已永久删除；权威 SQLite、canonical archive、恢复
演练和脱敏 fixture 均保留。范围、回执与删除后验证见
`docs/acceptance/005d-legacy-cleanup-readiness-20260726.md`。

## 13. Storage mode 生命周期

历史模式的最终处置为：

| 模式     | 定位                    | 终态                           |
| -------- | ----------------------- | ------------------------------ |
| `files`  | legacy fixture 历史语义 | 已从产品 composition root 移除 |
| `dual`   | legacy 差异历史语义     | 已从产品 composition root 移除 |
| `sqlite` | 正常在线业务模式        | 唯一正式模式                   |

Canonical audit 是否开启是独立维度，不由 storage mode 隐式决定。在线配置语义为：

```text
SHIFT_HOME=<user-home>/.shift
SHIFT_STORAGE_MODE=sqlite
SHIFT_AUDIT_TRANSCRIPT=on
SHIFT_RAW_EVENT_LOG=off
```

`SHIFT_AUDIT_TRANSCRIPT` 控制 SQLite canonical 审计归档。关闭时权威 SQLite 事务不创建
outbox row，health 显示 `disabled`，不会形成无法投递的假积压。离线 migrate/audit
测试可读取 fixture transcript，但它们不是产品服务的存储模式，也不参与在线读取。
canonical archive 固定从 `SHIFT_HOME/data/audit-transcripts` 派生；raw provider log 固定
从 `SHIFT_HOME/data/raw-events` 派生。旧 `SHIFT_AUDIT_TRANSCRIPT_DIR`、
`SHIFT_TRANSCRIPT_DIR` 和 `SHIFT_MEMORY_DB` 不再是在线路径入口。

`dual` 退出条件：

1. 新 storage epoch、schema version 和 cutover time 已落库；
2. SQLite-only 路径覆盖正常 API；
3. 新 epoch 的 session/message/invocation/memory 因果与完整性审计通过；
4. SQLite backup 可在空目录恢复权威数据并通过完整性审计；
5. tombstone 能阻止已清除或已 purge 的事件复活；
6. recall/FTS/memory search 可从新 epoch source 重建；
7. SQLite 失败和归档积压有可见健康状态；
8. outbox 已接管 canonical JSONL；
9. CI 不再依赖 online file fallback 或真实 legacy 数据；
10. legacy 行为场景已转换为最小化、脱敏 fixture；
11. 备份恢复演练通过，并已生成旧数据清理清单。

以上退出条件已全部满足，真实 legacy 数据已删除，`files/dual` 在线产品分支也已退役。

全新安装必须在不存在的 `SHIFT_HOME/data/shift.sqlite` 上通过显式命令创建、激活 clean
epoch。现有仓库运行数据必须通过一次性 home migration 命令迁移：

```text
npm run storage:init-home
npm run storage:migrate-home
```

命令拒绝覆盖或合并已有目标数据库及其 WAL/SHM sidecar。旧 validation DB 不得原地激活
或复用为 clean epoch；home migration 完成后，旧仓库数据库只能作为备份，不得恢复为在线
路径。

## 14. 实现关闭状态

SQLite 正式路径的 truth boundary 已完成：session/message/invocation、provider resume、
memory 和 recall/detail 正常读取均不访问 legacy 文件；SQLite 错误 fail closed；canonical
event 通过 transactional outbox 幂等归档；health、retention、恢复演练和 legacy 清理均
已有验收证据。

2026-08-09 amendment 只改变正式数据库的物理位置并增加 Project 生命周期边界，不重新
打开 `files/dual`。其完成状态以 ADR-006 和对应实现 PR 为准；在实现提交落地前，本节随后
列出的历史关闭结论仍只描述原 storage-mode cutover。

兼容代码收尾已完成：

- `createServerStorage` 明确拒绝非 SQLite 在线模式，`event-store` 只写 SQLite；
- composition root、chat route 和 recall service 已移除 storage mode branch；
- 旧 session read wrapper 已删除，产品直接使用 SQLite session service；
- `dual-write-recorder` 已收敛并更名为 fail-closed durable recorder；
- 产品不再读取 session-map、legacy invocation registry 或 legacy transcript；
- dual audit、legacy migrate、cleanup tooling 和脱敏 fixture 仅保留为离线工具/测试。

project-memory materialization workflow 由 §6.3 所述的后续 ADR/spec 决定，不是本次 SQLite
真相源切换的关闭条件。新增功能不得扩大或重新激活平级双源范围。

## 15. 实现顺序

1. 建立 storage audit 和 dual divergence 指标，不改变行为；（已完成）
2. 定义并持久化 storage epoch、schema version 和 cutover time；（已完成）
3. 为每个在线 API 标记 authoritative read path；（已完成）
4. 增加 transactional outbox 和 archive health；（已完成）
5. 将 session/message/invocation 正常读取切到 SQLite；（已完成）
6. 将 recall/detail 正常读取切到 SQLite；（已完成）
7. 实现 SQLite backup 的空目录恢复演练和 recovery report；（已完成）
8. 将 transcript 开关与 storage mode 解耦；（已完成）
9. 将默认模式改为 `sqlite`，移除正常服务中的 file merge/fallback；（已完成）
10. 将必要 legacy 场景固化为脱敏 fixture，执行备份恢复演练；（已完成）
11. 满足退出条件后删除 `dual` 产品模式，并通过独立清理操作删除真实 legacy 数据。
    （已完成）

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
12. 在线业务只打开 `SHIFT_HOME/data/shift.sqlite`，不得读取仓库旧数据库；
13. Project 归档只改变可见性和正常检索资格，不物理删除所属 Thread；
14. availability 必须区分 empty、degraded 和 unavailable。

## 17. 后果

### 正面

- 正常读取和故障语义更容易解释；
- 删除、恢复和断代切换不会互相复活数据；
- SQLite 事务真正保护 message/invocation/memory 一致性；
- JSONL 仍保留可审计、可导出和恢复后核对价值；
- 正式项目知识可以跟随 Git 分支、review 和跨机器传播；
- recall、摘要和未来 embedding 可以安全重建；
- 存储代码已删除在线 mode branch 和重复合并逻辑。

### 代价

- 需要 outbox、恢复工具和健康监控；
- 放弃旧历史查询与恢复能力，并需要一次可审计的断代清理；
- materialization 需要审批、diff 和 source-hash 生命周期；
- SQLite 成为正式依赖，数据库故障不能再由旧文件静默掩盖；
- 永久删除必须同时处理数据库和审计归档；
- 离线 legacy 工具和 fixture 仍需维护，但不会进入产品服务路径。

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
