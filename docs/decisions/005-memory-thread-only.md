---
title: "ADR-005: Product Memory is thread-only; project truth in docs"
status: accepted
decision_id: ADR-005
created: 2026-08-06
amended: 2026-09-06
scope: memory write, inject, recall memory layer, project knowledge
supersedes:
  - "Default decision/constraint → project scope in memory-data-contract"
related:
  - ../memory-data-contract.md
---

# ADR-005：产品 Memory 仅会话级；项目真相进 docs

## 状态

**Accepted — implemented**

产品 Memory 只允许 thread；`scope=project` 写入被拒绝。现行 schema、ownership 和注入
规则以 `docs/memory-data-contract.md` 为准。

## 背景

`decision` / `constraint` 曾默认写入 `scope=project`，未改代码的方案讨论也会变成
跨会话「项目事实」，并在弱 query 下被 bootstrap 注入（例如「你是谁」带入鉴权结论）。

## 决策

1. 产品 Memory（`memory_entries` 的 decision/constraint/fact）**只允许 thread**。
2. `memory_write` / `createProduct` 传入 `scope=project` **拒绝**。
3. Active Memory 注入与 `listActiveForTurn` **只读当前 thread**。
4. 跨会话项目结论必须 **主动写入仓库文档**（优先 `docs/decisions/`），经 project
   evidence 索引后用 `recall_search` 的 `project-doc` 检索；不自动注入 prompt。
5. 存量 active project 产品记忆用脚本 supersede 退役（`scripts/retire-project-memories.js`，
   在线库为 `SHIFT_HOME/data/shift.sqlite`，不要默认仓库 `data/runtime`）。
6. Agent / session 检索的 product Memory 固定 `memoryScope=thread`，不得再通过
   `project`/`all` 跨 thread 命中 project 行。
7. 退役导出写到 `archive/memory-exports/`（不进 `docs/**` project-doc 索引）；
   basename `legacy-from-memory*` 在 project-evidence 中硬排除。

## 后果

- 未落地的功能讨论不再污染其它会话。
- 项目级知识可 git 审查；代价是 Agent 需显式写 docs，不能靠 project Memory 偷懒。
- Schema 可暂时保留 project 列以承载历史 superseded 行。
