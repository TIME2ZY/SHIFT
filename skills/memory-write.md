---
name: memory-write
description: 将可复用结论写成 L3 记忆（decision / constraint / fact）
always: true
---

# 结构化记忆写入

把**后续 turn 还应遵守**的结论写入 L3 记忆；过程噪音不要写。

## 何时写

- 用户明确拍板（「就用 X」「以后别 Y」）
- 架构 / 约束变更，会影响后续实现
- 已核实的关键事实（端口、路径、约定）

## 何时不写

- 临时进度、猜测、一次性 debug 步骤
- Active Memories 里已有且未变化的内容
- 大段日志或完整文件内容

## kind

| kind | 含义 |
|------|------|
| `decision` | 选了什么 |
| `constraint` | 禁止 / 必须 |
| `fact` | 可核对的客观信息 |

## topic

- **必填**、短、稳定（如 `storage-primary`）
- **同主题变更必须复用同一 topic**（系统会 supersede 旧条）

## 怎么写（二选一）

CLI（细节以回调工具说明为准）：

```text
node scripts/callback-client.js memory-upsert --kind decision --topic storage-primary --content "在线读写以 SQLite 为准"
```

或在回复中写 fenced 块（turn 结束自动落库）：

````markdown
```memory
kind: decision
topic: storage-primary
content: 在线读写以 SQLite 为准
```
````

写前不确定是否已有 → `session-search --layers memory --query "<topic>"`  
写错 → `memory-invalidate --id <memoryId> --reason "..."`
