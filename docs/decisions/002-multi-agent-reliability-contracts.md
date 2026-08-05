---
title: "ADR-002: Multi-Agent Reliability Contracts"
status: accepted
decision_id: ADR-002
created: 2026-07-28
scope: invocation lifecycle, A2A handoff hops, memory funnel metrics, collab task/phase, live report schemas
supersedes: []
related:
  - ./001-storage-truth-boundary.md
  - ./004-five-phase-collaboration-workflow.md
  - ../../src/shared/collab-contracts.js
---

# ADR-002：多 Agent 可靠性契约

## 1. 状态

**Accepted — contracts only (phase 0)**

本 ADR 冻结多 Agent 协作的**命名与形状**。实现分阶段落地（写路径、状态机、handoff
幂等、记忆漏斗、任务状态、seal、可观测、UI）；**不得**在未更新本契约的情况下改枚举名。

权威代码源：`src/shared/collab-contracts.js`。

## 2. 背景

Live 多 Agent 协作证明「能跑」，但暴露：

- invocation 半成功（有 SSE 正文、无 durable finish、状态长期 active）；
- 验收以 HTTP 200 / 非空文本 / 「见过 agent」为绿，掩盖 stream error；
- A2A hops 用 `agent-start 数 - 1` 误计；
- 同一 handoff 可被 callback 与 chat 双消费；
- 记忆 inject 条目数与真正渲染进 prompt 混淆；
- 协作无任务状态，review 重复启动；
- 报告仍用 solo 字段，出现 `undefined`。

下一阶段重点是**状态闭环、可度量、低重复**，不是继续加 Agent 或场景。

## 3. 决策摘要

1. **Invocation 规范状态机**  
   `created → started → streaming → completed | failed | cancelled | sealed`。  
   每个 `agent-start` 必须有唯一终态；`done` 前不得残留无终态 invocation。

2. **与现 SQLite 的映射（阶段 0 不改 CHECK）**  
   当前 DB：`active | completed | failed | aborted`。
   - `created|started|streaming` → DB `active`
   - `cancelled` → DB `aborted`
   - `sealed` → DB `completed` + `terminalReason: "sealed"`（不扩独立 sealed 列作必选）  
     迁移与强制转移在 phase 1–2 实现。

3. **有效 A2A hop**  
   不是 `starts - 1`。一条 hop 是可追踪闭环：  
   `sourceInvocation → handoffId → parsed → routeAccepted → targetInvocation → targetCompleted`。  
   仅 `isEffectiveA2aHop(record) === true` 计为有效协作跳。

4. **Handoff 幂等**  
   唯一 `handoffId` 与/或 `contentHash`；同一 source、target、goal 只消费一次；  
   重复返回 `duplicate` / `already_completed`。多块 fence 只认一个 canonical block。

5. **记忆漏斗分层**  
   `retrieved → ranked → selected → rendered → delivered → used → correct`。  
   禁止用单一 `memory-inject` 条数冒充全链路成功。截断须带 `dropped` / `dropReason`。

6. **协作任务状态（phase 5 enforce）**
   `planned → implementing → awaiting_review → changes_requested → fixed → approved → delivered`。
   Approval 应绑定 diff/证据 hash（实现阶段）。此状态集合已由 ADR-004 的五阶段模型取代。

7. **Phase agent allowlist（默认）**
   discuss: gemini, codex；implement: grok, opencode；review: opencode。
   跨 phase 路由须显式策略，不能仅靠 prompt。当前 allowlist 以 ADR-004 为准。

8. **报告 schema**  
   `common` / `multiAgent` / `memory` / `worktree` / `performance` 必填键见  
   `REPORT_SCHEMAS`；缺键应使报告校验失败（phase 10 接入 runner）。

## 4. 非目标（本 ADR / phase 0）

- 不修改 `chat-routes`、durable finish、handoff 路由实现。
- 不新增 SQLite migration。
- 不改 live 断言（phase 9）。
- 不改 UI（phase 8）。

## 5. 实施顺序（引用）

```text
0 contracts (this ADR)
1 durable write / shutdown
2 invocation state machine + orphan
3 handoff id / idempotency / effective hop
4 memory funnel + conflict
5 collab task + phase policy
6 seal / capacity / workspace
7 encoding + cost signals
8 UI boundaries
9 acceptance (later)
10 report wiring (later)
```

## 6. 后果

- 后续 PR 必须 `require` 本模块中的枚举与 `isEffectiveA2aHop` / `validateReport`，避免字符串漂移。
- DB 映射函数集中在 `toDbInvocationState` / `fromDbInvocationState`，避免各处私自 map。
- 扩大状态机或 hop 定义时先改本 ADR 与 `collab-contracts.js`，再改运行时。
