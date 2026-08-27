---
name: a2a-handoff
description: Agent 之间通过行首 @mention 自动路由 — 全员共用 handoff 模板，可选字段可空
triggers:
  - "@Codex"
  - "@Gemini"
  - "@Grok"
  - "@OpenCode"
  - "帮我 review"
  - "帮我写测试"
  - "帮我实现"
always: false
---

# Agent-to-Agent 路由规则

需要其他 Agent 介入时：

1. **行首** `@AgentName`（触发路由）
2. **同一条回复**附标准 ` ```handoff ` 块（全员同一套字段）

## 当前 Agent 阵容

| Agent         | id       | 职责                                        |
| ------------- | -------- | ------------------------------------------- |
| **@Codex**    | codex    | 开始/末尾把关、参与讨论、收敛方案、最终验收 |
| **@Gemini**   | gemini   | 正常讨论、提供选项/反例、与 Codex 互证      |
| **@Grok**     | grok     | 先给具体修改方案，获批后实现、测试并总结    |
| **@OpenCode** | opencode | 代码 review；通过后规范 commit、push 和 PR  |

可接收的 `intent` 以本轮 identity 的 **Workflow capabilities** 为准。平台按 `role-contracts` 校验；不匹配的交接在 balanced / strict 下拒绝。不要在 prompt 里维护第二份名单。

> 路由写 `@名字` 或 `@id` 均可。同一 agent 可在链路中再次入队。

推荐链路（角色职责不等于固定状态数量）：

> `@Codex` ↔ `@Gemini` 讨论互证 → Codex 收敛 → `@Grok` 先给具体修改方案 → 获批后实现并总结 → `@OpenCode` review / 回修闭环 → OpenCode 交付 PR → `@Codex` 按用户目标与收敛方案最终验收

## 出口检查

```
回复前问自己："到我这里结束了吗？"
```

- **还需要下一个 Agent 行动** → 行首 `@` + 完整 handoff 块
- **不需要别人行动** → 不要 @；OpenCode review 通过后仍需完成交付并以 `accept` 交给 Codex

过关模板不在本 skill：Grok 方案见 `implementation-plan`；Codex 收敛/验收见 `solution-baseline-acceptance`；OpenCode review/交付见 `code-review-deliver`。

## 全员共用 handoff 模板

**只允许下列顶层字段。** 没有的内容就空着（省略该行）；**禁止** `verdict` / `nits` / `blocking` / `status` 等私有 key。

后继 Agent **看不到**你的 tool 过程。fence 必须是一份能单独续工的包，不要指望对方去读你的原文附录。

| 字段                          | 策略                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `to`                          | 推荐，与行首 @ 一致                                                    |
| `intent`                      | 推荐：`discuss, plan, implement, review, fix, deliver, accept, recall` |
| `goal`                        | 推荐：用户目标、范围、约束                                             |
| `what`                        | 必填：已完成什么、做到哪（含 review 结论）                             |
| `why`                         | 必填：为什么交 / 为何阻塞                                              |
| `next_action`                 | 必填：**唯一**下一步；能引用用户原句则引用                             |
| `files`                       | `implement/review/fix/deliver/plan` 应填：路径 + 为何重要              |
| `evidence`                    | 同上：失败过什么、怎么验证的；用户原话照抄                             |
| `tradeoff` / `open_questions` | 可选                                                                   |

````markdown
```handoff
to: opencode
intent: review
goal: 登录 API 无状态鉴权；不做 refresh token；错误码保持现有 401/403
what: |
  已完成: POST /api/login，JWT 签发，bcrypt 哈希
  做到哪: 实现与单测已绿，待独立 review
why: 需求要求无状态鉴权；现有 session 方案与多实例部署冲突
tradeoff: 放弃服务端 session；短期不做 refresh token
open_questions:
  - token TTL 是否应对齐产品 7 天要求
next_action: 审查密码哈希、JWT 声明与错误码是否安全一致；用户原句「先把登录鉴权做对」
files:
  - src/server/auth.js — JWT 签发与密码校验
  - tests/auth.test.js — 登录成功/失败路径
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
