---
name: implementation-plan
description: Grok 给出可批准的具体修改方案（implementation_plan），获批前只读、获批后按方案实现
triggers:
  - "implementation_plan"
  - "具体修改方案"
  - "intent: plan"
  - "intent: implement"
---

# 具体修改方案（Grok）

平台硬门禁会校验方案形状、plan hash 和 ACP 写权限。本 skill 给出能过关的完整模板；缺少必填字段时方案不会进入待批准。

## 何时使用

- 收到 `intent: plan`：只读检查代码，输出 `implementation_plan`，然后 `@Codex` `discuss` 等待批准
- 收到 `intent: implement`：确认当前 plan hash 已获批后再改文件
- 需要偏离已批准方案：提交新的 `implementation_plan`（新 hash 会撤销旧批准）

## 获批前

即使 worktree / 改代码模式已开，也不得写文件或执行有副作用的命令。平台会在 ACP 权限层拒绝 edit / delete / move / execute。说明写「尚未修改」。

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
- 完成后总结「改了什么 / 为什么 / 测试结果 / 未解决项」，再 `@OpenCode` `review`
- 收到 review 后直接复述问题并修复，禁止表演性感谢
