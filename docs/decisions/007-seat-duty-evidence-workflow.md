---
title: "ADR-007: Seat, Duty, and Evidence-Based Workflow"
status: accepted
decision_id: ADR-007
created: 2026-09-03
amended: 2026-09-06
scope: provider availability, thread seats, invocation duties, routing, gates, and completion
supersedes:
  - ./004-five-phase-collaboration-workflow.md
related:
  - ./001-storage-truth-boundary.md
  - ./002-multi-agent-reliability-contracts.md
  - ../collaboration-data-contract.md
  - ../architecture-map.md
---

# ADR-007：动态席位、按跳职责与证据验收

## 1. 状态

**Accepted，core model implemented**

本 ADR 的 Seat、Duty、按职责 Skill、任务卡、accept Duty 完成与证据绑定合同已进入在线路径。
Provider availability 是进程内派生观测，启动后检测一次，手动重新检测，无 TTL；当前代码锚点由
`docs/architecture-map.md` 描述。

ADR-004 中 Invocation 终态、handoff 幂等、SQLite 真相源、artifact hash 绑定和证据失效等
已经成立的可靠性约束继续有效。本 ADR 只替换固定 Agent 职责、按工号路由、强制五阶段和
按工号门禁。

## 2. 背景

落地前的实现把三类概念绑定在同一个 Agent ID 上：

- Provider 决定 CLI/ACP 如何启动；
- 固定角色决定该 Agent 能做什么；
- phase allowlist 和 gate 决定该 Agent 何时能接收 invocation。

因此只安装一个 Provider 时，任务可能因为缺少 Grok、OpenCode 或 Codex 而无法走到验收；
增加第二个 Provider 后，同一份 review 或 deliver 剧本也不能自由换席位执行。用户首先看到
固定团队和阶段，而不是目标、执行者、阻塞和完成证据。

## 3. 决策

### 3.1 分离 Provider、Seat、Duty、Policy 与 Human

```text
ProviderProfile  本机 Runtime 的启动方式、协议、模型档案和运行能力
Seat             某 Thread 已启用的执行席位
Duty             某次 Invocation 承担的职责
DutyBinding      Invocation 与 Seat、Duty、Skill、路由原因的不可变绑定
Policy           依据 Duty、证据和实际执行能力判定的门禁
Human            控制台操作者：提出目标、选择席位、停止运行；不是审批 actor
```

ProviderProfile 不保存默认岗位。Seat 不获得终身职责。任何已启用且满足运行能力和 Duty
约束的 Seat 都可以执行该 Duty。

Seat 的数量为 `0..N`；创建可执行 Thread 时必须选出至少一个 Seat。零 Seat 只用于明确的
不可执行或等待配置状态，发送任务时必须显式失败，不能静默选择 catalog 中的 Provider。

### 3.2 Duty 集合

本阶段固定以下 Duty：

```text
discuss | plan | implement | fix | review | deliver | accept | recall
```

Duty 是 invocation 级合同，不是 Thread 的长期岗位。每个 started invocation 必须恰好存在一条
DutyBinding；绑定必须在 invocation start 的同一事务中持久化，不能先启动再补写。

DutyBinding 至少包含：

```text
invocationId, threadId, seatId, duty, skillName,
routingReason, enforcementLevel, createdAt
```

`routingReason` 固定为：

```text
explicit_mention | handoff_to | sticky | affinity | solo_fallback
```

### 3.3 路由顺序

路由只在当前 Thread 的可路由 Seats 中选择：enabled 与 available/unknown 的交集。
可用性不改 Seat 编制；明确不可用的 mention 忽略，其他目标继续；零可路由席位发送显式失败。
检测使用真实传输短生成与约 25 秒墙钟超时，不写业务实体；超时记 unknown。
真实 Provider 认证、地区和启动失败立即更新观测，普通任务失败不影响名单。顺序如下：

1. 行首 `@Seat` 或结构化 `handoff.to` 明确指定 Seat 时，选择该 Seat；未启用则拒绝。
2. 结构化 handoff 指定下一跳 Duty、但未指定 Seat 时，按 Duty allow、运行能力、prefer 和
   avoid 对可路由 Seats 排序，并记录 `affinity`。
3. 没有 mention、没有 handoff 时保持当前可路由 Seat，并记录 `sticky`；当前不可用时选择可路由席位；Duty 变化本身不得触发换席。
4. review 等 Duty 只有原执行 Seat 合格时允许自审，并记录 `solo_fallback`。
5. 证据无法裁定时显式失败或保持 `active` 并列出 blocker，不插入 Human 审批，也不继续轮询 Provider。

禁止在全量 catalog 上轮询、禁止模型自行指定未启用 Seat、禁止把 prefer 写成排他的 Agent ID
allowlist。现有 mention 代码块过滤、自 mention 过滤、fan-out、深度限制和 handoff 幂等继续保留。

### 3.4 Duty Skill

Duty 的操作剧本由平台 Skill 提供。运行时只激活当前 Duty Skill 和短 handoff 合同，不按
Provider ID 注入一整套固定岗位说明。

Skill 元数据可以声明 Duty、运行能力要求、prefer 和 avoid；`allow` 的最终判定必须同时考虑
Thread enabled Seat 与 Provider 的实际运行能力。Skill 文本不得把 Codex、Grok 或 OpenCode
写成职责的唯一执行者。

worktree 中的 Skill 是仓库 `skills/` 权威源的派生副本。物化器只能替换或删除带 SHIFT
所有权标记的副本，不得删除用户自己的 `.agents/skills` 内容。上一跳残留的副本不得被当前
invocation 当作 active Skill。

### 3.5 门禁

门禁依据 Duty、artifact/evidence hash 和 Provider 实际执行能力，不依据 Seat 或 Provider 名称。

写权限实施等级固定为：

```text
enforced | advisory | unavailable
```

- `enforced`：平台能在工具或进程边界拒绝未批准写入；
- `advisory`：平台只能记录和提示，不能声称已经阻止写入；
- `unavailable`：该 Provider 无法安全执行所需 Duty，路由必须拒绝。

方案批准绑定规范化 plan hash；目标、方案、diff 或 commit 变化时，依赖旧 hash 的下游证据
必须失效。方案批准由 `discuss` / `accept` Duty 的 implement 交接写入；最终完成由 `accept`
Duty 的 `final_acceptance` 加上平台证据核验写入。二者都进入同一协作事件入口，不藏在某个
Provider 的隐式权限中，也不经过 Human 审批闸门。

结构化 `code_review` 由 `recordCodeReview` 单独写入 `codeReviewGate`，不要求同一轮输出
`delivery_receipt`。`delivery_receipt` 只进入 `recordDeliveryEvidence`。handoff 正文不得用
正则猜测 approve / request-changes 来改写或清空审查门禁；`handoff.goal` 不得覆盖
`goalOriginal`。

### 3.6 Task 状态与可选阶段投影

Thread 的协作任务以目标、阻塞和验收状态为主，不再以五阶段作为权威状态机。权威状态固定为：

```text
active | waiting_human | accepted | rejected
```

`waiting_human` 不是交接或完成的必经状态。完成态只能由 `accept` Duty 加上证据门禁写入
`accepted` 或 `rejected`；证据不足时保持 `active` 并列出 blocker。

当前 Duty 来自 active/latest DutyBinding。`discuss → implement → review → deliver → done` 可以
作为只读策略投影展示，但不得决定哪个 Agent ID 可以工作，也不得产生第二套写入口。

任务目标同时保存用户原话、收敛目标和 goal hash。目标变更必须通过协作任务的唯一写入口，
并使绑定旧 goal hash 的验收失效。

### 3.7 完成证据

任务根据 evidence profile 判定完成：

| Profile               | `accepted` 的最低证据                               |
| --------------------- | --------------------------------------------------- |
| `code_change`         | 实际 commit、验证结果、review 结论、goal hash 一致  |
| `working_tree_change` | 明确 diff、验证结果、未提交状态说明、goal hash 一致 |
| `analysis`            | 可核验结论、引用或读取证据、goal hash 一致          |

PR 和 CI 能读取时必须记录真实值；无法读取时为 `unknown`，不得伪造成功。策略可以要求某类
任务必须有 PR 或成功 CI，但不能用统一的“无 commit 永不成功”阻断非代码任务。

最终验收只有：

```text
accepted | rejected | incomplete
```

Agent 自述 done 不改变任务状态。`accept` Duty 提交的结构化 `final_acceptance` 才是完成写入口：
证据齐且 verdict=accept 时写入 `accepted`；verdict=reject 时写入 `rejected`；证据不足时记录
`incomplete` 并保持 `active`。自审允许存在，但必须记录 `same_seat`；有另一合格 Seat 并经
handoff 选择时记录 `other_seat`。不得新增 Human-only 完成写入口。

### 3.8 Provider 探测

Provider 探测是带时间戳的派生运行状态，不是业务真相源：

```text
available | authentication_required | unavailable | unknown
```

探测在 server listening 后通过真实传输做一次短生成，约 25 秒墙钟超时，无 TTL；之后只在
用户手动刷新时再探。探测不得创建业务 invocation、message 或 handoff。上次结果一直保留到
下一次探测，不是带过期的缓存。SQLite 中的 enabled Seat 仍是 Thread 编制的唯一真相源。
用户可以手动启用状态为 `unknown` 的 Provider；实际拉起失败时必须产生显式
invocation/trace 失败，不能静默改派。

## 4. Human actor

协作事件必须区分：

```text
actorKind: human | seat | system
actorId: <human identity, seatId, or platform identity>
```

Human 是控制台操作者：提出最初目标、选择启用席位、停止运行。Human 不是交接、方案批准或
最终完成的权威 actor。用户目标捕获可以记录 `actorKind=human`；批准、handoff 和完成事件必须
记录 Seat。消息时间线可以投影这些事件，但不得反向成为审批真相源。

SHIFT 是 Agent 编排平台。主链路不得要求 Human 确认或批准才能启动下一跳或写入完成态。

## 5. Handoff 边界

核心 Seat/Duty 迁移沿用现有 durable handoff 的 accept、enqueue、bind 和 terminal 生命周期。
策略通过后，`finalizeA2ARoutes` 立即调用唯一的 `acceptHandoff` 写入口并入队目标 hop，不插入
确认弹窗、预览 API 或请求内等待。取消确认语义不存在；未通过策略的交接直接 skip/repair。
handoff 仍只消费一次，并由 SQLite 的 accept/enqueue/bind/terminal 生命周期仲裁。

## 6. 真相源与读模型

- SQLite 是 Thread Seats、DutyBindings、协作任务、审批、handoff 和验收的唯一在线真相源。
- Provider 探测和 affinity 排序结果是派生运行信息；最终路由原因随 DutyBinding 持久化。
- 任务卡和验收卡是 SQLite 的只读投影，不从 SSE 内存恢复业务事实。
- Git 工作区继续是代码、diff、branch 和 commit 的真相源；SQLite 只保存已核验引用和 hash。
- Skill 权威源继续是仓库 `skills/`；worktree 副本不得反向覆盖它。

详细字段、唯一写入口和失效规则见 `docs/collaboration-data-contract.md`。

## 7. 主链路影响

本 ADR 不改变 Invocation、Trace、Message 和 Handoff 的单一终态入口。目标实现必须保持：

1. Thread 创建并绑定 Project，同时形成明确的 enabled Seats；
2. 用户消息只从 enabled Seats 选择入口；
3. invocation start 与 DutyBinding 原子持久化；
4. SSE 继续输出 text、tool 和 progress；
5. invocation 仍进入 completed、failed 或 aborted；
6. Message、Invocation、DutyBinding 和规范事件写入 SQLite；
7. 刷新或重启后从 SQLite 恢复任务与席位；
8. handoff 仍只消费一次，并绑定可追踪的目标 invocation。

## 8. 迁移和旧路径退出

后端已完成一次纵向切换，不再维护两套公开选席/门禁语义：

1. 现有 Thread 中出现过的 Agent ID 按 Provider 回填为 enabled Seat。
2. collaboration task 的 goal、artifact、gate 和历史事件已迁移；五阶段只供只读投影，
   不是在线路由真相。
3. `AGENT_ROLE_CONTRACTS`、`agentIdsForRole`、`role-contracts.js` 和按 Agent ID 的
   intent/phase allowlist 已退出在线热路径。
4. gate、identity、handoff policy、Skill 投递和 Web 类型使用 Seat/Duty 合同。
5. 保护固定工号语义的测试已删除或合并。
6. `docs/architecture-map.md` 与 README 描述当前 Seat/Duty 路径。

不得重新引入第二个公开路由、门禁或写入口，也不得把 ADR-004 的工号表接回热路径。

## 9. 验收条件

- 只启用一个 Provider 时可以从目标执行到证据验收，不因缺少固定 Agent 失败。
- 两个 enabled Seats 可以先后加载同一份 review Skill，门禁语义不变。
- 没有 mention 或 handoff 时保持当前 Seat。
- 未启用 Seat 的明确路由被拒绝且不改派。
- 每个 active invocation 恰好有一条持久化 DutyBinding。
- advisory 权限不会展示为 enforced。
- 目标、方案、diff 或 commit 变化后，旧的依赖证据不能复用。
- 刷新和重启后的任务卡、验收卡与 SQLite 一致。
- 固定工号路由与门禁退出在线热路径。

## 10. 后果

- 本机一个 Provider 也能完成主链路，多 Provider 提供换席 review 和工具选择。
- Provider 能否执行 Duty 由实际运行能力和策略共同决定，不再由品牌名决定。
- 五阶段仍可用于解释复杂协作，但不是所有任务的强制承诺。
- DutyBinding 增加持久化契约，但减少固定工号、隐式批准、Human 审批闸门和重复路由语义。
- handoff 策略通过后直接 durable accept/enqueue；不保留请求内确认门禁。
