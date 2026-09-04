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
`handoff`；目标必须属于当前 Thread 的 enabled Seats。不要猜测或点名 catalog 中未启用的 Provider。

```handoff
to: <enabled Seat label or provider id>
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
`files` 和 `evidence`，让接手 Seat 不依赖上一跳工具 transcript。只有 Human 能决定产品取舍、批准
或去留时，停下并提问，不要自动寻找另一个 Runtime。

系统会在交接入队前向用户展示可编辑摘要。用户确认后才会创建 durable handoff 并启动目标
invocation；取消、超时或停止当前运行都不会形成目标 handoff。
