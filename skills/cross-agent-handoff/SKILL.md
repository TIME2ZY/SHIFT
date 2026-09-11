---
name: cross-agent-handoff
description: 每个 Duty 共用的短交接卡；行首 @Seat 与结构化 handoff 形成可续工下一跳
duties: [discuss, plan, implement, fix, review, deliver, accept, recall]
preferTags: []
allow: anyEnabledSeat
avoid: ""
triggers:
  - "handoff"
  - "交接"
always: false
---

# 共用交接卡

## 当前任务状态

每轮先核对平台注入的 Current Task Context。需求基线、有效计划和进度以当前版本为准，
不能用旧 seal 包或 handoff 改写原始用户目标。长运行、提交进度或变更目标前，调用
`shift_context.task_read` 核对最新 goal hash、plan hash、用户补充和证据。

在完成一个有意义步骤、遇到阻塞或准备交接时，通过正文或 `postMessage` 提交以下 JSON fence。
无计划时 `plan_hash` 为 null；列表无内容用 []，完成项必须附可核对证据。verification 写实际
命令、代码版本、范围、结果和日志引用；这些是 Agent 报告，不代表平台已验证或任务已验收。

```task_progress
{"goal_hash":"<currentGoal.hash>","plan_hash":null,"current":"当前事项","completed":[{"item":"已完成事项","evidence":["commit、文件位置或测试日志引用"]}],"remaining":["未完成事项"],"blockers":[],"next_action":"下一步具体动作","verification":[]}
```

discuss/plan/accept Duty 需要根据用户补充修订目标时，先读取当前任务，仅引用其中真实的
用户 messageId。提交 `task_goal` JSON fence：`goal_hash`、`text`、`source_message_id`。
修订会撤销旧方案及依赖证据，不能把“继续执行”等消息自动解释成目标替换。收到拒绝事件时
读取最新状态后修正，不得假装更新成功。原始目标永久保留，不由 Agent 覆盖。

## 交接

没有点名、没有 handoff 时继续由当前 Seat 工作。需要切换 Seat 时，行首写 `@Seat`，并附同一份
`handoff`；目标必须属于当前 Thread 当前可跑的启用席位，以注入的可路由名单为准。不要猜测或点名名单外的 Provider。

选下一席时只使用注入的可路由名单，并参考已参与历史中每个 Seat 实际出现过的 Duty。`why` 写清选席理由（独立审查、能力匹配、sticky 或单席 fallback）。若只有一席可跑，不要 @ 自己，也不要写指向自己的 handoff；继续当前席，并在正文标明 solo fallback。当下一跳是 review，且存在另一可路由席位时，不要把 review 交给刚完成 implement/fix 的同一席。deliver 不要求换席。平台不按岗位自动换席。

```handoff
to: <routable Seat label or provider id>
intent: <discuss|plan|implement|review|fix|deliver|accept|recall>
goal: <用户目标与范围>
what: |
  已完成: ...
  做到哪: ...
why: <为何交接；关键约束>
next_action: <唯一下一步>
constraints:
  - 必须保持的约束
prohibited:
  - 明确禁止的动作
files:
  - path — 为何重要
evidence:
  - 失败或验证
```

`what`、`why`、`next_action` 不应为空。`plan`、`implement`、`fix`、`review`、`deliver` 应携带
`files` 和 `evidence`，让接手 Seat 不依赖上一跳工具 transcript。不要为交接、批准或完成去请求
人确认；证据不足时写出合同或显式失败，不要停下来等人。

策略通过后，平台立即创建 durable handoff 并启动目标 invocation。不要等待用户确认摘要。
