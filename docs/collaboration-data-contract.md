# Collaboration Data Contract

> **状态：** ADR-007 目标契约，尚未实现。
>
> **范围：** Thread Seat、Invocation Duty、协作任务、Human 事件与验收证据。
>
> **当前实现：** 仍见 `docs/architecture-map.md`。在迁移完成前，本文件不得用于声称运行时
> 已经支持动态席位。

## 1. 所有权

| 业务事实                | 权威源                            | 唯一写入口目标                            | 派生读模型                     |
| ----------------------- | --------------------------------- | ----------------------------------------- | ------------------------------ |
| Thread enabled Seats    | SQLite `thread_seats`             | Thread Seat service                       | Session / task card            |
| Invocation DutyBinding  | SQLite invocation binding         | `durableRecorder.startInvocation` 事务    | execution timeline / task card |
| Task goal and status    | SQLite collaboration task         | collaboration task registry/service       | collaboration read model       |
| Approval and acceptance | SQLite collaboration task + event | workflow evidence entry                   | acceptance card / timeline     |
| Handoff lifecycle       | SQLite handoffs                   | existing `finalizeA2ARoutes` + repository | handoff timeline               |
| Provider availability   | runtime probe cache               | provider discovery service                | Seat picker                    |
| Git evidence            | Git worktree                      | existing delivery verifier records refs   | task / acceptance card         |

表名和函数名中标记为“目标”的项目可以在实现中调整，但同一业务事实只能保留一个公开写入口。
任何命名调整都必须同步更新 ADR、测试和架构地图。

## 2. Thread Seat

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
  duty: discuss | plan | implement | fix | review | deliver | accept | recall
  skillName: string
  routingReason: explicit_mention | handoff_to | sticky | affinity | solo_fallback
  enforcementLevel: enforced | advisory | unavailable
  createdAt: timestamp
}
```

不变量：

- 每个 started/active invocation 恰好一条绑定。
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
  observedAt: timestamp
  expiresAt: timestamp
}
```

该对象是缓存和读模型，不是核心业务事实。探测不得写 Message、Invocation、Handoff 或协作任务。
用户手动选择 `unknown` Provider 时只改变 Seat 配置；启动失败仍由正常 Invocation/Trace 失败语义记录。

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

- `goalOriginal` 保存触发任务的用户原话，后续不得覆盖。
- 收敛目标变化产生新 `goalHash`，并使绑定旧 hash 的 final acceptance 失效。
- `waiting_human` 必须带可枚举 blocker；恢复执行后回到 `active`。
- `accepted` 只能由 evidence gate 写入；Agent 文本中的 done 不产生状态转换。
- 阶段是读模型投影，不能作为 Seat 或 Provider ID allowlist。

建议 blocker 集合：

```text
waiting_human | waiting_approval | missing_evidence |
provider_unavailable | execution_failed
```

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

- Human 批准和验收必须进入该权威事件路径。
- Seat actor 使用 `seatId`，不能把 Provider ID 当作长期人员身份。
- Message 时间线只投影事件；删除或隐藏投影不影响批准事实。
- event payload 中的批准、review 和验收必须携带对应证据 hash。

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

决策顺序固定为 explicit target、Duty-only handoff affinity、sticky、solo fallback、Human
escalation。没有 mention/handoff 时禁止仅因 Duty 改变而换 Seat。

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

本合同不引入新 Provider、dispatch outbox、SSE cursor、默认四人流水线或人格系统。
handoff preview/confirm 需要独立的 durable 状态设计，不属于核心 Seat/Duty 切换。
