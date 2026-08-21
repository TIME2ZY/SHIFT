---
name: cross-agent-handoff
description: 交接必须写 WHY — 全员共用 handoff 字段（可选可空）
triggers:
  - "交给"
  - "handoff"
  - "接手"
  - "交接"
  - "帮我 review"
---

# 交接必须写 WHY

**针对的弱点**：AI 缺乏持久记忆 — 每次对话从零开始，接手方不知道为什么这样改。

平台解析 ` ```handoff ` 块；缺软必填会标 degraded，但不阻断路由。

## 全员共用字段（与 a2a-handoff 一致）

| 字段                              | 说明                    | 可空？                  |
| --------------------------------- | ----------------------- | ----------------------- |
| **what**                          | 具体交了什么 / 审了什么 | 尽量不空                |
| **why**                           | 为什么这样做 / 为何阻塞 | 尽量不空（最重要）      |
| **next_action**                   | 希望对方做什么          | 尽量不空                |
| to / intent / goal / tradeoff     | 目标、机器意图与取舍    | `intent` 推荐，其余可空 |
| open_questions / files / evidence | 列表补充                | 可空                    |

**禁止**私有顶层字段：`verdict`、`nits`、`blocking`、`status`、`action`。  
Review 结论写进 `what`（如 `结论: request-changes` + P0 列表）。

## 机器格式

````markdown
```handoff
to: opencode
intent: review
goal: review CAS 乐观锁
what: 给用户模块加了 CAS 乐观锁
why: 高并发下出现数据覆写，需要防竞态
tradeoff: 放弃悲观锁方案，因为读多写少
open_questions:
  - 锁重试次数是否需要可配置？
next_action: 请 review 锁的使用是否正确
files:
  - src/user/repo.js
```
````

## 检查流程

```
BEFORE 发送交接消息:
  1. 行首 @目标Agent
  2. CHECK: handoff 是否包含 what / why / next_action？
  3. 若缺 why，补齐后再发
  4. 可选字段没有就省略，不要编造
```

## 反例 / 正例

```
❌ "@OpenCode 我改了三个文件，帮我看看"
   → 无 handoff 块、无 Why

❌ handoff 里写 verdict / nits 顶层字段
   → 解析器丢弃，接手方拿不到结构化意见

✅ 行首 @OpenCode + what/why/next_action（其余可空）
```
