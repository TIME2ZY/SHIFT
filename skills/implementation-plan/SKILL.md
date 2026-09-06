---
name: implementation-plan
description: plan / implement / fix Duty 的方案、执行、测试与回修剧本
duties: [plan, implement, fix]
preferTags: [code, test, worktree]
allow: anyEnabledSeat
avoid: ""
triggers:
  - "implementation_plan"
  - "具体修改方案"
  - "intent: plan"
  - "intent: implement"
---

# 方案、实现与回修

平台门禁会校验方案形状和 plan hash；Provider 支持权限回调时还会在运行边界实施写权限。本 skill 给出能过关的完整模板；缺少必填字段时方案不会进入待批准。

## 何时使用

- 当前 Duty 为 `plan`：只读检查代码，输出 `implementation_plan`，然后交给 discuss 或 accept
  Duty 用 `intent: implement` 批准。不要等人批准。
- 收到 `intent: implement`：确认当前 plan hash 已获批后再改文件
- 需要偏离已批准方案：提交新的 `implementation_plan`（新 hash 会撤销旧批准）

## 获批前

即使 worktree / 改代码模式已开，也不得写文件或执行有副作用的命令。`enforced` 会在权限回调层拒绝 edit / delete / move / execute；`advisory` 必须明确说明平台无法硬阻止写入。说明写「尚未修改」。

硬拒绝由平台执行，不靠自觉。

## 模板

必填：`summary` / `files` / `changes` / `tests`。`risks` 可空。

````markdown
```implementation_plan
summary: <方案摘要>
files:
  - <预计修改的文件>
changes:
  - <逐项具体改法>
tests:
  - <验证命令或测试范围>
risks:
  - <风险或边界；没有则省略>
```
````

## 获批后

- 严格按批准方案实现；给不出测试证据就标明未验证
- 完成后总结「改了什么 / 为什么 / 测试结果 / 未解决项」
- 若存在另一可路由席位，将 review 交给该席，不要 @ 自己
- 仅一席可跑时不要 @ 自己、不要写 self-handoff；继续当前席自审，并在总结中标明 same-seat / solo fallback
- 收到 review 反馈时先复述技术问题；确认问题后直接修复并验证，避免表演性感谢
- 请求 review 前先完成必要测试和自检，把未验证项与已知问题写进 handoff evidence
