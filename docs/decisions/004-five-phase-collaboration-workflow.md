---
title: "ADR-004: Five-Phase Collaboration Workflow"
status: accepted
decision_id: ADR-004
created: 2026-08-05
scope: handoff intent, collaboration phase, durable artifacts and approval gates
supersedes:
  - ADR-002 collaboration task states and phase allowlist
related:
  - ./001-storage-truth-boundary.md
  - ./002-multi-agent-reliability-contracts.md
  - ../../src/shared/collab-contracts.js
---

# ADR-004：五阶段协作工作流

## 1. 状态

**Accepted**

本 ADR 取代 ADR-002 中七状态协作任务模型和旧 phase allowlist。Invocation、handoff
幂等、memory funnel 与报告 schema 等其余 ADR-002 契约保持有效。

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

### 3.3 角色集合

```text
lead:       codex
discussion: codex, gemini
implement:  grok
review:     opencode
delivery:   opencode
```

Codex 的最终成果验收属于 deliver 阶段，不取代 OpenCode 的代码 review。

### 3.4 Phase allowlist

```text
discuss: codex, gemini
implement: grok
review: opencode
deliver: opencode, codex
recall: all four agents
```

### 3.5 角色能力契约

Phase allowlist 只表达某阶段有哪些参与者，不能区分同处 `deliver` 阶段的 OpenCode 交付和
Codex 最终验收。因此运行时还必须按 handoff `intent` 校验接收方 capability：

```text
discuss:   codex, gemini
plan:      grok
implement: grok
fix:       grok
review:    opencode
deliver:   opencode
accept:    codex
recall:    all four agents
```

四个角色的单一机器真相源是 `src/agents/role-contracts.js`。Agent catalog、identity prompt、
handoff 角色集合和路由策略必须从该契约派生，避免提示词职责与平台实际权限漂移。

其中：

- Gemini 是正常讨论与验证伙伴，不要求固定脑暴数量，也不以奇思妙想为默认输出；
- Codex 负责开始把关、参与讨论、收敛方案，以及按用户最初目标和收敛方案最终验收；
- Grok 负责先给具体修改方案，获批后实现，完成后总结改动与验证；
- OpenCode 负责代码 review；通过后负责规范 commit、push 与 PR 交付。

### 3.6 持久化与审计

SQLite 是 collaboration task、artifact、gate 和 transition event 的真相源。Gate 后续必须
绑定对应 plan/diff/commit/goal hash；进程内状态只能作为无持久化调用的兼容路径。

## 4. 分阶段实现范围

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
- commit subject 强制 Conventional Commit / 72 字符限制，body 强制说明原因；PR body 强制四个审计章节；
- Codex `final_acceptance` 绑定 user goal / solution / implementation plan / commit hash，并逐项提供 pass/fail 证据；
- 只有 OpenCode review、delivery、CI 与 Codex 目标验收全部匹配，`deliver` 才能进入 `done`。

PR4 仍不增加 phase。`solutionBaseline`、`codeReviewGate`、`deliveryGate` 和 `finalGate` 都是
现有阶段内的 versioned evidence；任何上游方案修订都会撤销失效的下游证据。

## 5. 后果

- `changes_requested` 是 `review → implement` transition event，不是 phase。
- OpenCode approve 进入 `deliver`，但不能直接进入 `done`。
- `done` 最终必须由目标、方案、review、commit 与 CI gate 共同决定。
- 旧 handoff 无 intent 时继续兼容，但会在提示模板中引导生成显式 intent。
