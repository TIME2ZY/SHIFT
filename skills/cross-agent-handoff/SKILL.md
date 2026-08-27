---
name: cross-agent-handoff
description: 交接必须写 WHY — 全员共用 handoff 续工包，implement/review 要带 files 与 evidence
triggers:
  - "交给"
  - "handoff"
  - "接手"
  - "交接"
  - "帮我 review"
---

# 交接必须写 WHY

路由格式与全员字段见 `a2a-handoff`。本 skill 只强调 why / next_action，避免空交接。

**针对的弱点**：AI 缺乏持久记忆 — 每次对话从零开始，接手方不知道为什么这样改。

平台解析 ` ```handoff ` 块；缺 `what/why/next_action` 会标 degraded。`implement/review/fix/deliver/plan` 缺 `files`/`evidence` 会标续工不足，默认仍放行。

## 全员共用字段（与 a2a-handoff 一致）

| 字段                          | 说明                           | 可空？                                   |
| ----------------------------- | ------------------------------ | ---------------------------------------- |
| **what**                      | 已完成什么 / 做到哪 / 审了什么 | 不空                                     |
| **why**                       | 为什么交 / 为何阻塞            | 不空                                     |
| **next_action**               | 唯一下一步                     | 不空                                     |
| to / intent / goal / tradeoff | 目标、机器意图与取舍           | `intent`/`goal` 推荐                     |
| **files**                     | 路径 + 为何重要                | `implement/review/fix/deliver/plan` 应填 |
| **evidence**                  | 失败、验证、用户原话           | 同上                                     |
| open_questions                | 未决问题                       | 可空                                     |

**禁止**私有顶层字段：`verdict`、`nits`、`blocking`、`status`、`action`。  
Review 结论写进 `what`（如 `结论: request-changes` + P0 列表）。

## 机器格式

````markdown
```handoff
to: opencode
intent: review
goal: review CAS 乐观锁
what: |
  已完成: 给用户模块加了 CAS 乐观锁
  做到哪: 实现已提交，待 review
why: 高并发下出现数据覆写，需要防竞态
tradeoff: 放弃悲观锁方案，因为读多写少
open_questions:
  - 锁重试次数是否需要可配置？
next_action: 请 review 锁的使用是否正确；核对 compare-and-swap 窗口
files:
  - src/user/repo.js — CAS 更新路径
evidence:
  - 复现过并发覆写；尚无并发单测
```
````

## 检查流程

```
BEFORE 发送交接消息:
  1. 行首 @目标Agent
  2. CHECK: handoff 是否包含 what / why / next_action？
  3. 若缺 why，补齐后再发
  4. implement/review/fix/deliver/plan：files 带为何重要，evidence 带验证
  5. 没有的字段省略，不要编造
```

## 反例 / 正例

```
❌ "@OpenCode 我改了三个文件，帮我看看"
   → 无 handoff 块、无 Why

❌ handoff 里写 verdict / nits 顶层字段
   → 解析器丢弃，接手方拿不到结构化意见

✅ 行首 @OpenCode + what/why/next_action；写代码/review 时再带 files 与 evidence
```
