---
name: merge-approval-gate
description: 合入前必须经 reviewer 确认 — 外部检查点防止过度自信
triggers:
  - "合入"
  - "merge"
  - "ready to merge"
  - "合入 main"
  - "合并"
---

# 合入前必须经 reviewer 确认

**针对的弱点**：AI 过度自信 — 修完后自己判断"改对了"就合入，不会自我质疑。

## 核心规则

```
❌ 错误流程:
修复 → 自己判断"改对了" → 合入 main

✅ 正确流程:
修复 → npm run verify:pr → 回给 @OpenCode 确认 → Reviewer 放行 + CI 绿色 → 合入 main
```

## 检查流程

```
BEFORE 合入:
  1. CHECK REVIEW: @OpenCode/Reviewer 是否给出了明确的放行信号？
  2. CHECK CI: PR 的 Verify pull request CI 是否全部绿色？
  3. BLOCK: Reviewer 未放行或 CI 未通过时，阻止合入并提示
  4. PASS: Reviewer 明确放行且 CI 绿色后才允许合入
```

## 有效的放行信号

✅ 以下信号表示可以合入：
- "可以放行了"
- "LGTM"（Looks Good To Me）
- "通过"
- 明确的审批标记

❌ 以下信号**不是**放行：
- "整体 OK，但 XXX 需要改"（条件放行 = 还没放行）
- "只剩小问题"（还有问题就不能放行）
- 没有回复（沉默 ≠ 同意）
- 自己判断"应该改对了"（AI 不能自己给自己放行）

即使 Reviewer 已放行，CI 仍在运行、失败或被取消时也不能合入。反过来，CI 绿色也不能替代 Reviewer 的明确审批。

## 为什么必须有外部检查点

AI 不会自我质疑。它会执行你的指令。

强制"必须经 @OpenCode 确认"是在流程中插入一个外部检查点，防止 AI 的过度自信导致错误合入。

## Block 场景

```
❌ "我修完了 review 的 3 个 P1 和 1 个 P2 问题，应该改对了，直接合入吧"
   → BLOCK: @OpenCode 没有给出明确放行信号
   → 提示: 请将修复结果发回 @OpenCode 确认后再合入

❌ "Reviewer 已经 LGTM，CI 还有一项失败，先合入再说"
   → BLOCK: Verify pull request CI 未全部通过
   → 提示: 修复失败项并等待 CI 绿色
```

## 通过场景

```
✅ @OpenCode: "LGTM，可以放行了"
   CI: Verify pull request 全部通过
   → Reviewer 放行和 CI 绿色同时满足，允许合入 main
```
