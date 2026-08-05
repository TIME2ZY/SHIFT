---
name: a2a-handoff
description: Agent 之间通过 @mention 自动路由 — 全员共用 handoff 模板，可选字段可空
triggers:
  - "@Codex"
  - "@Gemini"
  - "@Grok"
  - "@OpenCode"
  - "帮我 review"
  - "帮我写测试"
  - "帮我实现"
always: true
---

# Agent-to-Agent 路由规则

你是多 Agent 协作系统中的一个 Agent。需要其他 Agent 介入时：

1. **行首** `@AgentName`（触发路由）
2. **同一条回复**附标准 ` ```handoff ` 块（全员同一套字段）

## 当前 Agent 阵容

| Agent         | id       | 职责                                         | 可接收 intent                 |
| ------------- | -------- | -------------------------------------------- | ----------------------------- |
| **@Codex**    | codex    | 开始/末尾把关、参与讨论、收敛方案、最终验收 | `discuss`, `accept`, `recall` |
| **@Gemini**   | gemini   | 正常讨论、提供选项/反例、与 Codex 互证      | `discuss`, `recall`           |
| **@Grok**     | grok     | 先给具体修改方案，获批后实现、测试并总结     | `plan`, `implement`, `fix`    |
| **@OpenCode** | opencode | 代码 review；通过后规范 commit、push 和 PR   | `review`, `deliver`, `recall` |

> 路由写 `@名字` 或 `@id` 均可。同一 agent 可在链路中再次入队（例如 Grok → OpenCode → Grok）。

推荐链路（角色职责不等于固定状态数量）：

> `@Codex` ↔ `@Gemini` 讨论互证 → Codex 收敛 → `@Grok` 先给具体修改方案 → 获批后实现并总结 → `@OpenCode` review / 回修闭环 → OpenCode 交付 PR → `@Codex` 按用户目标与收敛方案最终验收

## 出口检查

```
回复前问自己："到我这里结束了吗？"
```

- **还需要下一个 Agent 行动** → 行首 `@` + 完整 handoff 块
- **不需要别人行动** → 不要 @；OpenCode review 通过后仍需完成交付并以 `accept` 交给 Codex

平台会按 `intent` 校验目标 Agent 的 workflow capability。角色不匹配的交接在 balanced / strict 策略下拒绝，而不是只靠提示词提醒。

### Grok 实现批准 Gate

- Codex 首次交给 Grok 时使用 `intent: plan`，这只开放 read/search/think/fetch
- Grok 必须输出完整 `implementation_plan`（summary / files / changes / tests；risks 可空）
- 方案会持久化并生成 plan hash；重复提交同一方案保持幂等
- 只有 Codex 可以用 `intent: implement` 批准当前 plan hash
- 方案缺失、未批准或 hash 已变化时，平台拒绝 implement 路由及 ACP edit/delete/move/execute
- Grok 修改方案会产生新 hash，并自动撤销旧批准及下游 review/delivery gate

## 全员共用 handoff 模板

**只允许下列顶层字段。** 没有的内容就空着（省略该行）；**禁止** `verdict` / `nits` / `blocking` / `status` 等私有 key。

| 字段                                                          | 策略                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `to`                                                          | 推荐，与行首 @ 一致                                                    |
| `intent`                                                      | 推荐：`discuss, plan, implement, review, fix, deliver, accept, recall` |
| `what`                                                        | 尽量填：交了什么 / 审了什么 / 结论                                     |
| `why`                                                         | 尽量填：为什么交 / 为何要改 / 为何阻塞                                 |
| `next_action`                                                 | 尽量填：希望对方立刻做什么                                             |
| `goal` / `tradeoff` / `open_questions` / `files` / `evidence` | 可选，可空                                                             |

````markdown
```handoff
to: opencode
intent: review
goal: 请 review 登录 API 的鉴权与错误处理
what: 新增 POST /api/login，JWT 签发，bcrypt 哈希
why: 需求要求无状态鉴权；现有 session 方案与多实例部署冲突
tradeoff: 放弃服务端 session；短期不做 refresh token
open_questions:
  - token TTL 是否应对齐产品 7 天要求
next_action: 审查密码哈希、JWT 声明与错误码是否安全一致
files:
  - src/server/auth.js
  - tests/auth.test.js
evidence:
  - npm test -- tests/auth.test.js 通过
```
````

### Review 结论也写进同一模板（不要第二套 schema）

把评审结论映射进 `what` / `why` / `next_action`：

````markdown
```handoff
to: grok
intent: fix
goal: 按 review 修完再回审
what: |
  结论: request-changes
  P0:
  - src/foo.js: CAS 竞态（步骤 3-4 窗口）
  P1:
  - 缺并发单测
why: P0 在并发下会丢更新，不能合入
next_action: 修 P0，补并发单测，再 @OpenCode
files:
  - src/foo.js
  - tests/foo.test.js
```
````

放行且无需行动：写清 `what: 结论: approve`（或 approve-with-nits），**不要**行首 @。

## 格式注意

- `@` 必须在**行首**（前面只能有空白）
- 代码块内的 `@` **不会**触发路由
- 不要 @ 自己
