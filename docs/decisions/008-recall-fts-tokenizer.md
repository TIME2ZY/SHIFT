---
title: "ADR-008: Recall FTS uses trigram tokenizer"
status: accepted
decision_id: ADR-008
created: 2026-07-30
amended: 2026-09-06
scope: recall_fts, memory_search_fts, project_passages_fts
supersedes: []
related:
  - ./001-storage-truth-boundary.md
  - ./003-recall-vector-index.md
  - ./005-memory-thread-only.md
---

# ADR-008：Recall FTS 使用 trigram tokenizer

> 曾用非正式标题「ADR 002」。正式编号是 ADR-008，避免与
> `002-multi-agent-reliability-contracts.md` 冲突。

## 状态

**Accepted — implemented**

## 背景

默认 FTS5 `unicode61` 能匹配英文 token，但不会把连续中文句子切成可独立查询的短语。
在当时语料上，`权威存储` 和 `在线读写` 对 `unicode61` 均为零命中；同一内容使用
FTS5 `trigram` 时可以命中。

RecallService 已有受作用域约束的 `contains` 降级，但把常见中文短语全部交给
`LIKE` 会削弱排名信息，并随着数据增长增加扫描成本。

## 决策

三个已有 FTS 投影统一使用：

```sql
tokenize='trigram'
```

不增加第二套并行中文索引。少于三个字符、FTS 查询不可用或查询语法不受支持时，
继续使用现有 scoped-contains 降级。

Memory topic 不依赖 trigram：`memory_search.topic` 使用独立的 thread 索引，
完全匹配返回 `exact-topic` 通道。产品 Memory 只有 thread 作用域（ADR-005）。

## 安全边界

- thread/project 条件仍在每个 SQL 查询中前置执行。
- tokenizer 不改变 Memory 生命周期和 superseded 过滤。
- FTS 表仍是可重建投影，权威内容来自业务表。
- 迁移重建 FTS 表和触发器，不修改业务行。

## 评测

运行：

```text
npm run eval:recall-fts
```

初始 v1 基线：

- Recall@10：1.000
- MRR：1.000
- Scope Leakage Rate：0
- Superseded Recall Rate：0
- 中文三字及以上短语进入 `fts` 通道
- 两字短语继续允许降级到 scoped-contains

该数据集是防回归基线，不代表 Hybrid 上线结论。Embedding 引入后必须在同一数据集
基础上增加同义表达和语义改写，再比较 FTS-only 与 Hybrid。

## 回滚

如 trigram 在真实数据上造成不可接受的索引体积或写入延迟，应通过新迁移重建
`unicode61` FTS 表；不要回滚业务 schema 或直接修改已应用迁移。
