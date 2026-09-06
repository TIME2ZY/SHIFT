---
title: "ADR-004: Five-Phase Collaboration Workflow"
status: superseded
decision_id: ADR-004
created: 2026-08-05
amended: 2026-09-06
scope: handoff intent, collaboration phase, durable artifacts and approval gates
superseded_by:
  - ./007-seat-duty-evidence-workflow.md
supersedes:
  - ADR-002 collaboration task states and phase allowlist
related:
  - ./001-storage-truth-boundary.md
  - ./002-multi-agent-reliability-contracts.md
  - ../../src/shared/collab-contracts.js
---

# ADR-004：五阶段协作工作流

## 1. 状态

**Superseded by ADR-007。实现已迁出，不得再当现行路径。**

本 ADR 曾取代 ADR-002 中七状态协作任务模型和旧 phase allowlist。Invocation、handoff
幂等、memory funnel 与报告 schema 等其余 ADR-002 契约仍有效。

ADR-007 已把固定 Agent 角色、五阶段权威状态和按 Agent ID 的路由替换为
Provider / Seat / Duty / Policy。`role-contracts.js`、工号 allowlist 和按品牌名的
implement / review / deliver / accept 门禁已退出在线热路径。下文角色表、
`WORKFLOW_ROLES` 和分阶段 PR 计划只是当时落地记录，不能再用来选席、写门禁或要求
特定 Provider 才能验收。当前实现以 ADR-007、`docs/collaboration-data-contract.md`
和 `docs/architecture-map.md` 为准。五阶段只允许作为只读投影，不是路由真相。

## 2. 背景

旧模型把 `changes_requested`、`fixed`、`approved` 等事件结果建模为长期状态，既扩大状态
数量，也无法表达方案、代码评审和最终验收分别绑定哪一版证据。同时 registry 只存在于
进程内，服务器重启会丢失 approval hash。

协作流程需要区分：

- Codex 与 Gemini 的讨论和收敛；
- Grok 的计划与实现；
- OpenCode 的代码评审；
- OpenCode 交付和 Codex 最终成果验收。

## 3. 决策

### 3.1 五个业务阶段

```text
discuss → implement → review → deliver → done
              ↑          │         │
              └─ changes ┘         │
              └─ final reject ─────┘
```

过程结果不再扩张 phase。方案、评审、交付和最终验收由 versioned artifact 与 gate 表达。

### 3.2 显式 handoff intent

标准 handoff 支持：

```text
discuss | plan | implement | review | fix | deliver | accept | recall
```

路由优先使用显式 `intent`；旧消息缺失 intent 时才根据目标、worktree 和正文弱推断。
intent 集合被 ADR-007 保留为 Duty 名；选席不再按下面的工号表。

### 3.3 当时的固定角色（已废止）

```text
lead:       codex
discussion: codex, gemini
implement:  grok
review:     opencode
delivery:   opencode
```

Codex 的最终成果验收属于 deliver 阶段，不取代 OpenCode 的代码 review。

### 3.4 当时的 Phase allowlist（已废止）

```text
discuss: codex, gemini
implement: grok
review: opencode
deliver: opencode, codex
recall: all four agents
```

### 3.5 当时的角色能力契约（已废止）

当时 Phase allowlist 只表达某阶段有哪些参与者，不能区分同处 `deliver` 阶段的 OpenCode
交付和 Codex 最终验收，所以还按 handoff `intent` 校验接收方 capability：

```text
discuss:   codex, gemini, grok, opencode
plan:      grok
implement: grok
fix:       grok
review:    opencode
deliver:   opencode
accept:    codex
recall:    all four agents
```

当时 `capabilities` 只表示谁可以被 handoff 到该 intent。阶段主人和硬 gate 按
`WORKFLOW_ROLES`：仅 Grok 驱动 implement/plan 门禁，仅 OpenCode 驱动 code review /
deliver，仅 Codex 发出 implement 批准与最终 accept。这套工号门禁已删除。

当时四个角色的机器真相源是 `src/agents/role-contracts.js`。该文件和按工号派生的
catalog / identity / handoff 合同已删除；现行路由只看 Thread Seat 与 DutyBinding。

当时的岗位说明（已废止）：

- Gemini：讨论与验证伙伴；
- Codex：把关、讨论、收敛方案，以及最终目标验收；
- Grok：先给具体修改方案，获批后实现；
- OpenCode：代码 review，通过后 commit / push / PR。

### 3.6 持久化与审计

SQLite 是 collaboration task、artifact、gate 和 transition event 的真相源。Gate 绑定
plan/diff/commit/goal hash。进程内 registry 不再作为协作任务真相源。

## 4. 当时的分阶段落地（已完成，角色绑定已废止）

下列 PR 计划已经做过；其中按工号绑定义务的部分随后被 ADR-007 删除。

首个实现 PR 只交付：

- 五阶段契约和显式 intent；
- durable collaboration task/event repository；
- chat 与 callback 共用持久化 registry；
- artifact/gate 存储形状。

Grok 计划期写权限、OpenCode Git/PR 操作和 Codex 目标验收门禁由后续 PR 实现。

第二个实现 PR 交付：

- 单一 Agent role/capability 契约；
- catalog、identity、handoff 与 API 元数据对齐；
- balanced / strict handoff 的 intent 目标能力校验；
- 四 Agent 职责提示更新。

本 PR 只使角色身份和交接边界可执行；Grok 计划批准前的文件写入硬门禁、OpenCode 的 Git/PR
执行器，以及 Codex 最终目标证据门禁仍由后续 PR 实现。

第三个实现 PR 交付：

- `implementation_plan` 结构化 artifact，要求 summary / files / changes / tests；
- 方案规范化 hash，以及 SQLite `implementationGate` 的 required / pending_approval / approved；
- 仅 Codex 可通过显式 `implement` handoff 批准当前 plan hash；
- 新方案 hash 自动撤销旧批准和下游 review / delivery / final gate；
- Grok ACP 在未批准时移除 `--always-approve`，权限层只放行 read / search / think / fetch，
  拒绝 edit / delete / move / execute / switch_mode / other；
- chat 和 callback 两条方案提交路径共用同一持久化 registry；
- `done` readiness 增加 implementation plan approval 前置条件。

该 Gate 不增加新的业务 phase；它是 implement 阶段内的 artifact/gate 状态，避免把状态机扩张为
“规划中、待批准、已批准”等长期 phase。

第四个实现 PR 交付：

- 平台保存不可由 Agent 静默改写的最初用户目标及其 hash；
- Codex `solution_baseline` 绑定用户目标、收敛方案、约束、非目标和逐项验收标准；
- OpenCode 输出结构化 `code_review` 与 `delivery_receipt`，并亲自完成 commit、push、ready PR 与 CI；
- 平台以只读方式独立核对 clean worktree、真实 commit、仓库默认 base、PR head、PR 描述和 GitHub checks；
- commit subject 强制 Conventional Commit / 72 字符限制，body 强制说明改动与原因；PR title 长度限制为
  10–100 个字符，PR body 强制使用 `## 意图`、`## 主链路影响`、
  `## 路径变化（公开入口 / 双写）`、`## 测试（旧接口测试是否处理）`、`## 风险与回滚`
  五个中文审计章节；
- Codex `final_acceptance` 绑定 user goal / solution / implementation plan / commit hash，并逐项提供 pass/fail 证据；
- 只有 OpenCode review、delivery、CI 与 Codex 目标验收全部匹配，`deliver` 才能进入 `done`。

PR4 仍不增加 phase。`solutionBaseline`、`codeReviewGate`、`deliveryGate` 和 `finalGate` 都是
现有阶段内的 versioned evidence；任何上游方案修订都会撤销失效的下游证据。

## 5. 后果

当时留下、ADR-007 仍承认的部分：

- `changes_requested` 是 `review → implement` 的 transition event，不是 phase。
- 最终完成由目标、方案、review、commit 与 CI 等证据门禁决定，而不是 Agent 自述 done。
- 旧 handoff 无 intent 时的弱推断只是兼容，新路径应写显式 Duty。

已废止、不得再执行的部分：

- 按 Codex / Grok / OpenCode 工号分配 discuss / implement / review / accept。
- `role-contracts.js` / `WORKFLOW_ROLES` 作为运行时真相。
- 只有指定品牌才能批准方案、提交 PR 或写最终验收。
