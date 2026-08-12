---
title: "ADR-002: Multi-Agent Reliability and Trace Contracts"
status: accepted
decision_id: ADR-002
created: 2026-07-28
amended: 2026-08-12
scope: trace identity, invocation lifecycle, A2A handoff hops, metric eligibility, memory funnel, and observability boundaries
supersedes: []
related:
  - ./001-storage-truth-boundary.md
  - ./004-five-phase-collaboration-workflow.md
  - ../../src/shared/collab-contracts.js
---

# ADR-002：多 Agent 可靠性与 Trace 契约

## 1. 状态

**Accepted — Phase 0A contracts; Phase 0B runtime wiring pending**

本 ADR 冻结 Trace、Invocation、Handoff、指标资格和 Memory 漏斗的命名与边界。现有
Invocation durable finish、Handoff 进程内幂等和 Memory funnel 已部分实现；本次 0A 只修改
契约，不宣称 Trace source tables、durable Handoff 或 Trace 查询已经落地。

当前实现路径以 `docs/architecture-map.md` 为准。0B 完成代码切换后必须同步更新该文件，
不得为了匹配本 ADR 的目标状态而保留旧热路径。

共享枚举和校验的代码真相源是 `src/shared/collab-contracts.js`。0B 新增或改变公开状态时，
必须先修改本 ADR，再修改共享契约和运行实现。

## 2. 背景

现有系统已经具备 SQLite Invocation、规范化 durable events、canonical audit outbox、
Provider diagnostics、Memory telemetry 和一次性 Handoff metrics，但它们的耐久度不同：

- Invocation start/finish 和 invocation events 是权威 SQLite 写入；
- Handoff accept、bind、complete 主要由进程内 registry 仲裁，重启后不能恢复；
- Memory telemetry 使用 best-effort 写入，不能天然成为可靠指标分母；
- `run-observability` 是请求内存对象并通过 SSE 输出，不是历史成功率真相源；
- `thread`、用户 turn、HTTP request attempt 和 invocation 尚未形成稳定的 Trace 身份；
- 单一父子树无法完整表达 fan-out、retry、repair、duplicate 和 supersede 因果关系。

如果直接基于这些数据做 Dashboard，会把包质量、路由接受、目标启动、Invocation 正常退出
和业务交付质量混称为“成功”，并在重启、SSE 断开或 telemetry 写失败时产生错误分母。

## 3. 标识符与生命周期

### 3.1 Group、Trace 与业务实体

| 标识符           | 语义                                                       | 所有者                          |
| ---------------- | ---------------------------------------------------------- | ------------------------------- |
| `thread_id`      | 多轮会话和 Project 绑定；等价于 Trace 系统的 group/session | SQLite Thread                   |
| `client_turn_id` | 用户提交的幂等意图标识，不代表一次执行尝试                 | SQLite Message                  |
| `trace_id`       | 服务端接受的一次 chat request attempt                      | SQLite Trace source row（0B）   |
| `invocation_id`  | 一次 Agent/Provider 执行                                   | SQLite Invocation               |
| `handoff_id`     | 一次跨 Agent 路由尝试                                      | SQLite Handoff source row（0B） |

规则：

1. `thread_id` 不是 `trace_id`；同一 Thread 可以包含多个 Trace。
2. `client_turn_id` 不直接充当 `trace_id`；supersede 或显式重试可以产生新的 attempt。
3. Trace ID 由服务端在请求通过鉴权、输入和可信 Thread/Project 校验后生成。
4. 每个在线 Invocation 必须属于一个 Trace；retry、window rotation 和 A2A target 继承当前
   Trace，不能自行创建平行 Trace。
5. Trace、Invocation 和 Handoff 的 Thread/Project 归属只能从可信服务端上下文派生。

### 3.2 Trace 生命周期

Trace source state 使用：

```text
active → completed | failed | aborted
```

- `completed`：请求的 durable 成功条件满足，且不存在未闭合的必需 Invocation/Handoff。
- `failed`：请求未达到 durable 成功条件，且失败并非用户主动取消。
- `aborted`：用户取消、请求被 supersede 或传输断开导致执行被主动终止。
- 终态 Trace 必须有 `ended_at`；`completed` Trace 不得包含 active Invocation。

同一 `thread_id + client_turn_id` 可以有多个 request attempt。每个 attempt 使用独立
`trace_id` 和单调 `request_attempt`，不得覆盖前一次 Trace。

### 3.3 Invocation 生命周期与结果

规范状态机保持：

```text
created → started → streaming → completed | failed | cancelled | sealed
```

当前 SQLite 映射保持：

- `created | started | streaming` → `active`
- `cancelled` → `aborted`
- `sealed` → `completed` + `terminal_reason = sealed`
- `completed | failed` → 同名 DB 状态

每个 Invocation 终态必须同时记录：

```text
terminal_reason
failure_stage
error_code
retryable
ended_at
```

`failure_stage` 只允许以下稳定分类；Provider 原始消息不得直接充当 stage：

```text
request | bootstrap | durable_start | provider_spawn | provider_run | stream
tool | recall | handoff_parse | handoff_route | handoff_target
persistence | seal | reconcile
```

成功路径的 `failure_stage` 和 `error_code` 为空。有 SSE 正文但没有 durable terminal，或
Invocation 已完成但缺少所需 assistant-final message，均不得计为成功。

## 4. 因果模型

Trace 默认展示为父子树，但业务因果是有向无环图：

- 结构父子：Trace → Invocation；Invocation → generation/tool/recall span（阶段 1）。
- 业务链接：fan-out Handoff、retry、repair、duplicate、supersede 和 resume。

稳定关系名为：

```text
caused_by | handoff_to | retry_of | supersedes | duplicate_of | repairs | resumes
```

0B 必须持久化 Invocation 与 Handoff 的必需因果坐标。通用 `span` / `span_link` 是后续可重建
Trace read model，不得成为 Invocation 或 Handoff 的第二业务真相源。

## 5. Durable Handoff 契约

### 5.1 闭环

有效 A2A hop 不是 `agent-start 数 - 1`，而是：

```text
source Invocation
  → handoff parsed
  → route accepted and enqueued
  → target Invocation durably bound and started
  → target Invocation terminal
  → handoff terminal
```

只有 route accepted、源/目标 Invocation 均可验证、目标 Invocation 成功终止且 Handoff
terminal 为 completed 的记录，才满足 `isEffectiveA2aHop`。

### 5.2 状态集合

```text
parse_status:    parsed | failed | skipped
route_status:    accepted | rejected | duplicate | already_completed
receive_status:  pending | started | not_started
complete_status: pending | completed | failed | aborted
```

规则：

1. 同一 source Invocation 与 target Agent 最多一个 accepted route。
2. `handoff_id` 全局唯一；`duplicate_of` 和 `repair_of` 必须指向同 Thread 的记录。
3. target Invocation 一旦绑定不得改绑，并且必须与 source 属于同 Thread 和 Trace。
4. target Invocation start 与 Handoff bind 必须在同一 SQLite 事务中提交。
5. target Invocation terminal 与 Handoff terminal 必须在同一 SQLite 事务中提交。
6. completed Handoff 不得退回 pending；恢复只能补齐可由权威数据证明的状态。
7. chat end 与 callback 可以触发同一 finalize 用例，但幂等必须在 SQLite 权威入口完成。
8. 0B 完成后，进程内 registry 必须退出 duplicate、binding 和 terminal 仲裁职责。
9. `accepted` 只表示 SQLite 已接受路由；`enqueued_at` 必须在目标确实加入本次调度队列后写入，
   不得在 accept 时预填。enqueue 确认写失败时必须撤销对应的进程内队列追加并 fail closed。
10. 服务启动必须先将遗留 active Invocation 写为 failed 并追加 durable `invocation-end`，再收口
    pending Handoff，最后将遗留 active Trace 写为 failed；三类状态不得在重启后长期 active/pending。

## 6. 指标语义与样本资格

### 6.1 样本资格

每个成功率样本必须分类为：

```text
eligible | pending | censored | unknown | excluded
```

- `eligible`：观察窗口已成熟、权威终态完整，可以进入分母。
- `pending`：仍在允许执行窗口内，不进入成功或失败分母。
- `censored`：用户中止、supersede 等外部终止，单独展示。
- `unknown`：旧版本或数据不完整，无法可靠判断，不得当作失败或成功。
- `excluded`：duplicate、already_completed、测试/维护等按指标契约排除的样本。

所有比例必须同时返回 numerator、denominator、pending、unknown 和时间窗口。UI 不得只显示
百分比；小样本必须显示样本量。

### 6.2 Handoff 指标

Handoff 分成三组，不提供无定义的单一“成功率”：

1. 协议质量：parse、packet quality、repair、to mismatch。
2. 调度可靠性：accepted、enqueued、target started、queue latency、orphan。
3. 执行与业务结果：target terminal success、end-to-end completion、review/user/eval acceptance。

当前 `handoff-metrics.ok_rate` 只表示 packet quality，不得命名为端到端成功率。
Invocation `completed` 也只证明执行闭合，不证明业务结果正确。

### 6.3 Memory / Recall 指标

在线漏斗保持：

```text
retrieved → ranked → selected → rendered → delivered → used → correct
```

- `available`、`degraded`、`unavailable` 必须分开统计。
- weak query、recency fallback 和显式 recall search 必须分 cohort。
- 非空结果率称为 hit rate，不得称为严格 Recall。
- `used` 和 `correct` 在有引用、用户反馈或 evaluator 证据前保持 unknown/null。
- 严格 `Recall@K`、MRR、nDCG 只来自带相关性标注的离线 eval 数据集。
- best-effort `memory_events` 可以支持诊断趋势，但在没有 completeness 证明时不能单独作为
  可靠 SLI 分母。

## 7. Trace、Audit 与观测健康

### 7.1 权威事实与投影

| 数据                         | 分类                                         |
| ---------------------------- | -------------------------------------------- |
| Trace request lifecycle      | SQLite 权威业务事实（0B）                    |
| Invocation lifecycle         | SQLite 权威业务事实                          |
| Handoff lifecycle            | SQLite 权威业务事实（0B）                    |
| Invocation durable events    | SQLite 权威规范事件                          |
| Trace spans、links、聚合指标 | 可重建读模型                                 |
| Memory telemetry             | best-effort 诊断事实，除非与业务事务原子写入 |
| SSE runtime                  | 临时展示状态                                 |
| Canonical JSONL              | outbox 驱动的审计归档                        |
| Raw provider log             | 可选短期诊断材料                             |

Trace read model 不得反向修改 source tables。Canonical JSONL 和 raw log 不参与正常在线恢复，
也不能用来补造成功终态。

### 7.2 完整性指标

观测系统必须能够暴露：

```text
missing_trace_id
terminal_invocation_missing_end_event
span_missing_end
handoff_missing_target
terminal_target_with_pending_handoff
terminal_trace_with_active_invocation
telemetry_write_failure
metric_projection_lag
outbox_pending_age
```

观测写入失败不得静默提升业务成功率。非权威 telemetry 失败可以不打断业务，但必须使相关
Trace/指标标记为 incomplete；权威 Trace、Invocation 或 Handoff 写入失败必须 fail closed。

## 8. Payload、隐私、采样与保留

1. 结构性 lifecycle 元数据默认全量持久化；成功 payload 可以采样，错误/降级 payload 保留。
2. 完整 prompt、response、tool 参数和环境变量默认不复制到 Trace 表；引用现有权威记录或
   保存摘要/hash。
3. Query 文本、Provider raw data、文件内容和 tool output 必须经过字段级 capture policy、
   脱敏和尺寸限制。
4. 每条可导出 Trace 记录 capture/redaction policy version；secret redaction 失败时拒绝导出
   敏感 payload，而不是降级为明文。
5. Metrics label 禁止使用 trace/thread/invocation/memory ID、完整 query 等高基数字段。
6. Trace payload、raw log、canonical audit 和聚合指标分别配置保留期；删除必须遵守 Thread
   purge 和 Project 隔离边界。
7. OTLP 或第三方 exporter 属于后续可选 sink，不改变 SQLite 业务权威边界。

## 9. Phase 0 实施边界

### 9.1 Phase 0A（本次文档提交）

- 更新 ADR-001 和本 ADR；
- 冻结身份、状态、因果、指标和隐私契约；
- 不修改 schema、runtime、SSE、UI 或 `architecture-map.md`；
- 不提前声称 durable Handoff 或 Trace source tables 已实现。

### 9.2 Phase 0B（后续实现提交）

按顺序落地：

1. Trace identity、request lifecycle 和统一 Invocation outcome。
2. Durable Handoff accept/enqueue/bind/complete 与重启 reconcile。
3. Trace 完整性查询、health 和旧进程内仲裁路径退出。
4. 更新 `architecture-map.md`，执行恢复演练和完整回归。

阶段 0 不包含 Trace Explorer、Dashboard、通用 tool/generation spans、feedback/evaluator、
告警或 OTLP exporter。

## 10. 后果

- Dashboard 不能读取 `run-observability`、SSE 或进程内 Handoff registry 作为历史成功率真相。
- 新增公开写入口时必须删除或收窄被替代路径，禁止 SQLite 与 Map 长期双仲裁。
- Trace 查询必须通过可信 Thread → Project 做服务端隔离。
- 阶段 1 可以从权威 Trace/Invocation/Handoff 构建 spans 和 links，而无需重写业务状态机。
- 任何新增状态、failure stage、metric denominator 或 capture policy 都必须先更新本 ADR。
