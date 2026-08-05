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

### 3.5 持久化与审计

SQLite 是 collaboration task、artifact、gate 和 transition event 的真相源。Gate 后续必须
绑定对应 plan/diff/commit/goal hash；进程内状态只能作为无持久化调用的兼容路径。

## 4. 本阶段范围

本 ADR 的首个实现 PR 只交付：

- 五阶段契约和显式 intent；
- durable collaboration task/event repository；
- chat 与 callback 共用持久化 registry；
- artifact/gate 存储形状。

Grok 计划期写权限、OpenCode Git/PR 操作和 Codex 目标验收门禁由后续 PR 实现。

## 5. 后果

- `changes_requested` 是 `review → implement` transition event，不是 phase。
- OpenCode approve 进入 `deliver`，但不能直接进入 `done`。
- `done` 最终必须由目标、方案、review、commit 与 CI gate 共同决定。
- 旧 handoff 无 intent 时继续兼容，但会在提示模板中引导生成显式 intent。
