# Collaboration Data Contract

> **状态：** ADR-009 平台契约与 ADR-007 软件团队契约已实现；Provider availability 仍是派生运行信息。
>
> **范围：** 平台 Task/Plan/Node/TeamRun 与软件团队内部 Seat/Duty/证据。
>
> **当前实现：** 代码锚点与尚存的兼容边界见 `docs/architecture-map.md`。

## 1. 所有权

ADR-009 将平台独立为 Task → 冻结 Plan → 可执行 Node → TeamRun → Artifact/Acceptance。Task UUID 不等于 Thread id，可以无 Project/Thread 创建。Thread 只绑定准备对话或一次团队尝试。

| 平台对象        | SQLite 权威表                     | 唯一写入口                                  |
| --------------- | --------------------------------- | ------------------------------------------- |
| Task / 冻结计划 | tasks / task_plans                | task-repository.create/saveDraft/submit     |
| 节点与尝试      | plan_nodes / team_runs            | task-repository.claimNext/bindRun/finishRun |
| 成果与验收      | task_artifacts / task_acceptances | finishRun 同一事务                          |
| 平台事件        | task_events                       | repository 用例内写入                       |

计划包含 goal/deliverables/acceptanceCriteria/subtasks；节点包含 id/title/description/workflowId/capabilities/dependsOn/deliverables/acceptanceCriteria。验证依赖存在、无环和总体验收条件/交付物的节点覆盖。
提交 CAS 草稿 revision，保存规范内容 hash、sourceRevision 与各节点 Team 绑定，FIFO seq 唯一。重复提交相同 sourceRevision 返回原 Plan，其他版本冲突。运行中不能修改计划；相关变更新建 parentTaskId 草稿。
TeamRun 唯一 (planId,nodeId,attempt)，SQLite 唯一全局运行槽；Task FIFO 与依赖就绪序决定领取。准备调用共享同一个进程槽。
依赖输入只包含完成节点的冻结成果与 Acceptance，带 contentHash。回执 hash 使用对象键排序的规范 JSON。完成事务检查匹配节点全部验收条件、非空证据、被选 Team 角色的 assessedBy、非空成果和内容版本，保存 Artifact ids 与 Acceptance；所有节点通过才完成 Task。通用平台不解释软件证据或 Git。
取消意图属于 Task.cancelling，Run/Node 保持 running 直到已有 executor 收口，之后统一 cancelled；服务中断记录 unknownSideEffect，失败尝试的产物不能成为依赖输入。

以下 Seat、Duty、collaboration_tasks 和 handoff 协议是软件 Team 内部状态，不是平台 Task。软件范围和 Team 由 TeamRun/PlanNode 的只读 join 得出 executionBinding；不复制通用合同或调度状态。旧 delegation 队列列在 v33 删除，来源与结果作为 legacySource 和离线快照保留，旧提交不自动执行。

软件共享工作树的组合验收：每次尝试 baseline 固定此前已完成的软件节点 id；团队自己的冻结范围保持本节点目标，内部验收条件还包含这些节点原有条件，须在当前工作树重新核验。引用通过 PlanNode 只读投影得到，不复制合同；旧尝试的条件集合不会随之后节点完成而增长。通用平台回执仍只匹配当前节点条件，累计复查属于软件 Team 责任。

runtime_server_lease 记录拥有当前 SHIFT_HOME 的服务进程身份；启动须原子领取，存活服务不可被第二个服务的恢复流程覆盖。
process.spawn_intent / process.bound / process.exited 经既有 EventStore 写入，进程读模型只做投影。
重启按 pid 与内核创建标识核对身份，再终止遗留进程；PID 已复用时不得误杀，无身份或无法确认停止时保留可观察阻塞。

| 业务事实                  | 权威源                            | 唯一写入口目标                            | 派生读模型                     |
| ------------------------- | --------------------------------- | ----------------------------------------- | ------------------------------ |
| Thread enabled Seats      | SQLite `thread_seats`             | Thread Seat service                       | Session / task card            |
| Invocation DutyBinding    | SQLite invocation binding         | `durableRecorder.startInvocation` 事务    | execution timeline / task card |
| Software scope and status | SQLite collaboration task         | collaboration task registry/service       | collaboration read model       |
| Approval and acceptance   | SQLite collaboration task + event | collaboration task registry               | acceptance card / timeline     |
| Handoff lifecycle         | SQLite handoffs                   | existing `finalizeA2ARoutes` + repository | handoff timeline               |
| Provider availability     | runtime probe cache               | provider discovery service                | Seat picker                    |
| Git evidence              | Git worktree                      | existing delivery verifier records refs   | task / acceptance card         |

表名和函数名中标记为“目标”的项目可以在实现中调整，但同一业务事实只能保留一个公开写入口。
任何命名调整都必须同步更新 ADR、测试和架构地图。

## 2. Thread Seat

第二阶段补充：task_inputs 保存 id/task_id/owner_task_id/name/locator/content_hash/byte_length；输入添加/移除只由 task-repository 的草稿 CAS 入口写入，Plan.inputs_json 固定提交时的引用。内容位于任务管理目录，读取必须核验 SHA256。Task 的 inputs 是冻结 Plan 或草稿输入引用的只读投影，关联草稿继承源版本及 ownerTaskId；联合主键 (task_id,id) 允许引用同一源材料。BOM 去除、CRLF/CR 转为 LF 后按保存字节算 hash，以 LF 分行提供 1-based 行号。

Invocation binding 为两种互斥形式：软件调用 duty/skillName，或准备、材料调用 workflowId/roleId（duty、skillName 均为 null）。二者复用 invocation_duty_bindings 和 durableRecorder.startInvocation 单一原子写入口；通用角色不进入软件 collaboration task。材料成果的 Acceptance.evidence 包含 assessedBy、traceIds、independentReview、reportHash、review 与 sourceChecks，但整体等级仍是 agent_reviewed。

目标记录：

```text
ThreadSeat {
  seatId: string
  threadId: string
  providerId: string
  label: string | null
  enabled: boolean
  affinityTags: string[]
  createdAt: timestamp
  updatedAt: timestamp
}
```

不变量：

- `seatId` 在 Thread 内稳定且唯一。
- 路由只读取 `enabled=true` 的 Seat。
- Provider 探测失败不自动删除或禁用 Seat。
- 零 Seat Thread 不得启动 invocation；必须返回可识别的配置阻塞。
- Seat 的启用、禁用和重命名不改写历史 invocation。

## 3. Invocation DutyBinding

目标记录：

```text
DutyBinding {
  invocationId: string
  threadId: string
  seatId: string
  duty: discuss | plan | implement | fix | review | deliver | accept | recall | null
  workflowId?: string
  roleId?: string
  skillName: string | null
  routingReason: capability_match | explicit_mention | handoff_to | sticky | affinity | solo_fallback
  enforcementLevel: enforced | advisory | unavailable
  createdAt: timestamp
}
```

不变量：

- 每个 started/active invocation 恰好一条绑定。
- 软件 duty/skillName 非空且 workflowId/roleId 为空；通用 duty/skillName 为空且 workflowId/roleId 非空，DB CHECK 保证互斥。
- 准备绑定 task_preparation/plan；材料绑定 materials_analysis/analyze|write|review。capability_match 表示平台能力选择；单席位复核记录 solo_fallback。
- binding 与 invocation start 同事务提交。
- binding 创建后不可改写；重试产生新的 invocation 和 binding。
- `seatId` 必须属于相同 Thread，且路由决策时处于 enabled 状态。
- 历史 Seat 后续禁用不影响已有 binding 的审计解释。
- `unavailable` 不能形成 started invocation；拒绝应发生在 start 之前并进入 Trace 显式失败路径。

## 4. Provider availability

```text
ProviderAvailability {
  providerId: string
  status: available | authentication_required | unavailable | unknown
  reason: string | null
  observedAt: timestamp | null
  checking: boolean
}
```

该对象是缓存和读模型，不是核心业务事实。探测不得写 Message、Invocation、Handoff 或协作任务。
运行配置按 catalog Agent ID 绑定（例如 gemini 的实际 Provider 为 antigravity），不能混用两个 ID。
服务 listen 后后台短生成检测一次，走配置的真实 CLI/ACP 传输，墙钟上限约 25 秒；
结果在本进程内保留，无 TTL 和定时重测。手动重新检测或重启后重新观测。
`routable = enabled Seat ∩ (available | unknown)`；检测、失败与恢复均不修改 Seat。
初始、超时和不确定错误为 unknown；认证、地区限制、二进制缺失为明确不可用。
探测中的非临时生成失败也记 unavailable（短生成没有业务任务）；CLI 未返回详细原因时明确显示原因未知。
余额不足也排除路由；真实会话的普通任务失败仍不改变 Provider 可用性。
真实调用中的明确 Provider 错误立即回写；任务失败、用户取消不改变可用性。
同一 Agent 检测去重，旧检测结果不能覆盖检测期间较新的真实调用观测。
prompt、mention（在 fan-out 截断之前）、当前发送席位均使用当前可路由名单。
协作合同额外注入本 Thread 已参与 Seat 及其 Duty 的派生列表（按 Seat 保留对应关系，不拆成两个全局列表），来源是 DutyBinding 与当前 in-memory binding，不构成新写入口；相同 Provider 的不同 seatId 保持独立；禁用或不可用席位只出现在参与历史，不能当作可 @ 目标。
不可用 mention 忽略，不创建 Handoff 或 repair；全部不可路由时发送显式失败。
已启动 Invocation 仍通过原终态入口闭环。UI 同时展示编制、可用性原因和重新检测入口。

## 5. Collaboration task

目标记录：

```text
CollaborationTask {
  threadId: string
  status: active | waiting_human | accepted | rejected
  goalOriginal: string
  goalNormalized: string | null
  goalHash: string
  evidenceProfile: code_change | working_tree_change | analysis
  artifacts: object
  gates: object
  createdAt: timestamp
  updatedAt: timestamp
  version: integer
}
```

不变量：

- `goalOriginal` 保存触发任务的用户原话，后续不得覆盖。handoff.goal 只属于该跳上下文，
  不得改写任务目标。
- 收敛目标变化产生新 `goalHash`，并使绑定旧 hash 的 final acceptance 失效。
- `waiting_human` 不是交接或完成的必经状态；不得用它表达人审批闸门。
- `accepted` 只能由 `accept` Duty 的 `final_acceptance` 在 evidence gate 通过后写入；Agent
  文本中的 done 不产生完成状态转换。证据不足时记录 `incomplete` 并保持 `active`。
- 阶段是读模型投影，不能作为 Seat 或 Provider ID allowlist。
- `codeReviewGate` 由 `recordCodeReview` 写入，是审查结论的唯一写入口；`deliveryGate` 由
  `recordDeliveryEvidence` 写入。approve 不要求同一轮 `delivery_receipt`；缺少 receipt 时
  任务保持 `active`，blocker 为等待交付，而不是尚未审查。
- 协作事件必须带 `actorKind` 与 `actorId`。用户目标为 `human`；批准、审查、handoff 与完成
  为 `seat`。

建议 blocker 集合：

```text
waiting_human | waiting_approval | missing_evidence |
provider_unavailable | execution_failed
```

### 每轮任务上下文与执行进度

每次 invocation（含 A2A、新 provider session、seal 后重试）读取当前 collaboration task，
通过同一个只读投影提供原始用户目标、当前目标及来源消息、需求基线、完整有效计划、
当前 Duty、进度、审查和交付证据。前端和 `shift_context.task_read` 复用同一投影。
不以 plan hash 代替计划正文；长运行可主动读取最新版本，读取不改变任何业务状态。

Agent 通过既有 workflow-evidence 提交 `task_progress` JSON fence，包含 `goal_hash`、
`plan_hash`（无计划为 null）、`current`、`completed`（`item` 与非空 `evidence` 字符串数组）、
`remaining`、`blockers`、`next_action`、`verification`（验证命令、版本、范围、结果和日志引用）。
平台验证当前 goal/plan 绑定与 invocation/Seat 身份，通过 registry 的唯一进度入口保存到
`artifacts.progress`，与协作事件同事务提交。完整相同的同 invocation 重放幂等；旧绑定、
无证据完成声明和非法结构显式拒绝。进度为 Agent 报告，不能写 accepted、批准方案或
冒充平台验证。新的计划/目标不复用旧进度；旧报告留在历史事件中。

初始原话不变。后续用户消息作为有 messageId 的补充指令持久化，不自动当作目标替换。
需要修订当前目标时，discuss/plan/accept Duty 提交 `task_goal` JSON fence（`goal_hash`、
`text`、`source_message_id`），来源只能是本任务已记录用户消息；同一来源重放幂等，
旧 hash 拒绝，修订保存来源并撤销依赖旧目标的方案、进度和验收证据。相同修订跨 invocation 重放复用结果；当前目标与来源均未变化时不撤销证据。同一输出先处理目标修订，再处理需求/计划等证据，最后保存绑定最新目标与计划的进度。

封存包只携带执行断点及引用，当前 task 投影优先于旧包。`context-restored` 规范事件记录
实际进入新调用提示词的封存事件 ID、任务版本与摘要 hash；它表示已注入，不声称模型已理解。
前端从 SQLite 读取包和恢复记录，不从是否换 session 推断注入成功。

## 6. Collaboration actor event

```text
CollaborationEvent {
  eventId: integer
  threadId: string
  eventType: string
  actorKind: human | seat | system
  actorId: string
  duty: Duty | null
  payload: object
  createdAt: timestamp
}
```

不变量：

- 方案批准、handoff 和最终完成必须进入该权威事件路径，并由 Seat actor 写入。
- Seat actor 使用 `seatId`，不能把 Provider ID 当作长期人员身份。
- Message 时间线只投影事件；删除或隐藏投影不影响批准事实。
- event payload 中的批准、review 和验收必须携带对应证据 hash。
- 最终完成事件记录 `actorKind=seat`、`duty=accept`，并绑定当前 goal、plan 与 commit；
  verdict=accept 但证据不足时记录 `incomplete`，不得返回伪成功，也不得改写成 Human 审批。

## 7. Evidence and invalidation

```text
AcceptanceEvidence {
  goalHash: string
  planHash: string | null
  diffHash: string | null
  commitSha: string | null
  prUrl: string | null
  ciStatus: success | failure | pending | unknown
  reviewMode: same_seat | other_seat | pending
  reviewVerdict: approved | changes_requested | unknown
  enforcementLevel: enforced | advisory | unavailable
  verdict: accepted | rejected | incomplete
}
```

失效顺序：

1. goal hash 变化使 plan approval、review、delivery 和 final acceptance 失效；
2. plan hash 变化使 implementation approval、review、delivery 和 final acceptance 失效；
3. diff/commit 变化使 review、delivery 和 final acceptance 失效；
4. review changes requested 使 final acceptance 失效并要求 implement/fix Duty；
5. CI failure 不能产生 `code_change` 的 accepted；CI unknown 是否阻断由显式策略决定。

当前 `code_change` 完成路径的 `accept` Duty 决定必须在写入前读取 Thread 绑定的 Git worktree：工作区应干净，HEAD
必须匹配已核验的 delivery commit。读取失败、缺少工作区或绑定不匹配时，请求 `accepted`
应记录为 `incomplete` 并给出原因。任务卡的 readiness 使用同一检查，不能仅凭 SQLite 中的
历史交付引用继续显示可验收。已有完成决定保留为历史事实，当前证据不匹配时不投影为已验收。

`implementation_plan` 的提交只依据 `plan | implement | fix` Duty 和方案内容；正文与
callback 共用 `processWorkflowEvidenceOutput`，再进入唯一 `submitImplementationPlan`
写入口。Provider 的权限回调能力只决定工具写权限能否强制执行，不决定方案是否可落库。

Evidence profile 最低要求：

| Profile               | 必需字段                                        |
| --------------------- | ----------------------------------------------- |
| `code_change`         | goal hash、commit SHA、验证证据、review verdict |
| `working_tree_change` | goal hash、diff hash、验证证据、未提交说明      |
| `analysis`            | goal hash、结论、来源或读取证据                 |

## 8. Routing decision

路由输入必须包含 Thread、当前 Seat、请求的 Duty、mention/handoff 和 enabled Seats 快照。
输出只有：

```text
RouteDecision {
  seatId: string
  duty: Duty
  skillName: string
  reason: RoutingReason
  enforcementLevel: EnforcementLevel
}
```

决策顺序固定为 explicit target、Duty-only handoff affinity、sticky、solo fallback。
没有 mention/handoff 时禁止仅因 Duty 改变而换 Seat。证据无法裁定时显式失败或列出 blocker，
不升级为人审批。

路由决定本身不单独成为第二真相源；成功启动时随 DutyBinding 保存，启动前拒绝则随 Trace/规范
事件记录失败原因。

## 9. 恢复与迁移

- 旧 Thread 的历史 Agent ID 映射成 Seat；映射必须可重复执行且不创建重复 Seat。
- 旧 collaboration phase、goal、artifact 和 gate 迁移到新任务合同，历史事件保留。
- 服务启动恢复时，active Invocation 缺少 DutyBinding 属于完整性失败，必须收口为 failed，不能
  猜测职责后继续执行。
- task card、acceptance card 和 active Seat 列表全部从 SQLite 重建。
- 迁移完成后，旧 Agent role/phase allowlist 不得继续参与在线路由或 gate。

## 10. 实施边界

本合同不引入新 Provider、dispatch outbox、SSE cursor、默认四人流水线、人格系统或 Human
审批闸门。handoff 在策略通过后通过既有 `finalizeA2ARoutes` 与 handoff repository 的唯一
accept/enqueue 路径立即持久化和消费。

请求内所有正文与 callback 交接共享同一个 A2A 计数。实际入队成功后才增加计数，不得把
计数快照回写运行状态。已接受的目标必须执行并收口，达到上限仅阻止继续接受下一次交接，
不能留下已入队但未启动的目标。
