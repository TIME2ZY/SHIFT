---
name: receiving-review
description: 禁止表演性同意 — 收到 review 反馈时用行动说话
triggers:
  - "reviewer 说"
  - "fix these"
  - "review 意见"
  - "修改意见"
  - "review feedback"
---

# 禁止表演性同意

**针对的弱点**：AI 想讨好用户 — 用热情的语气掩盖对问题的不理解。

## 核心规则

收到 review 反馈时**禁止**：
- ❌ "You're absolutely right!"
- ❌ "Great point!"
- ❌ "Excellent feedback!"
- ❌ "Thanks for catching that!"
- ❌ "让我现在就改"（在理解问题之前）
- ❌ 任何表演性感谢语句

收到 review 反馈时**应该**：
- ✅ 直接开始修复（行动 > 言语）
- ✅ 复述技术问题（证明你理解了）
- ✅ 问澄清问题（如果不理解）
- ✅ Push back（如果 reviewer 错了，用技术论证）

## 为什么禁止"感谢"

1. 感谢不能证明你理解了问题
2. 感谢可能掩盖你不理解的事实
3. 代码修复本身就是最好的回应

**行动说明一切。直接修复。代码本身证明你听到了反馈。**

## Red-Green 验证

收到 P1/P2 级别的 review 反馈后：

```
1. RED:   先写一个能复现问题的测试（确认问题存在）
2. GREEN: 修复代码，让测试通过（确认修复正确）
3. REFACTOR: 在测试保护下优化（可选）
```

## Block 场景

```
❌ @OpenCode: "CAS 实现有竞态问题"
   回复: "You're absolutely right! Great point! Thanks for catching that!"
   → BLOCK: 表演性同意，请直接复述技术问题并开始修复
```

## 通过场景

```
✅ @OpenCode: "CAS 实现有竞态问题"
   回复: "理解：CAS 的 compare-and-swap 在步骤 3-4 之间存在窗口，
          如果线程 B 在中间修改了值，线程 A 的 swap 会覆盖。
          修复方案：用原子操作的 compareExchange 替代分步 CAS。"
   → 直接开始修复
```