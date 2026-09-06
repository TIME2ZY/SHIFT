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
