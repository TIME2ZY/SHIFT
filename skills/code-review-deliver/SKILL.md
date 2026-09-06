---
name: code-review-deliver
description: review / deliver Duty 的代码审查与 Git/PR 证据剧本
duties: [review, deliver]
preferTags: [git, diff, pr]
allow: anyEnabledSeat
avoid: sameSeatIfImplementerAndAnotherSeatExists
triggers:
  - "code_review"
  - "delivery_receipt"
  - "intent: review"
  - "intent: deliver"
  - "创建 PR"
---

# 代码 review 与交付

当前 invocation 承担 review 或 deliver Duty。平台独立读取 worktree、commit、PR 和 GitHub checks；文本声明不能替代真实交付。同一份剧本可由任意当前可跑的启用席位 执行。

用注入的已参与历史识别哪个 Seat 执行过 implement / fix。若另有可路由席位，不要把 review 交给该实现席（`avoid: sameSeatIfImplementerAndAnotherSeatExists`）。deliver 可以留在当前席，不要求为了独立性再换席。仅一席可跑时不要 @ 自己；自审必须在 code_review 中显式标明 same-seat，不能伪装成换席审查。

## Review

先弄清改动目标与约束，再按 P0 / P1 / P2 分级。每条问题给位置、原因、建议。区分必须改与可选改进。

需要修复时交回合适的 enabled Seat，并使用共用 `handoff`（不要 `verdict` / `nits` / `blocking` 顶层字段）：

- `what`：`结论: request-changes|approve-with-nits|approve` + P0/P1 列表
- `why`：阻塞原因
- `next_action`：希望 implement/fix Duty 立刻做什么

````markdown
```code_review
verdict: <approve|changes_requested>
summary: <评审结论>
findings:
  - <P0/P1/P2 问题；无问题写 none>
tests:
  - <实际验证及结果>
```
````

可放行时进入 deliver Duty；若当前只要求 review，应明确给出下一动作。

## 交付（approve 之后）

在当前 worktree 运行 `npm run verify:pr`，规范 commit、push、创建 ready PR，并等待 GitHub checks。

- commit subject：Conventional Commit，不超过 72 字符
- commit body：说明改动与原因
- PR title：10–100 个字符
- PR body 必须包含：`## 意图` / `## 主链路影响` / `## 路径变化（公开入口 / 双写）` / `## 测试（旧接口测试是否处理）` / `## 风险与回滚`

````markdown
```delivery_receipt
commit_sha: <40-char commit sha>
pr_url: <https://github.com/.../pull/...>
base_branch: <master|main|实际目标分支>
verification:
  - npm run verify:pr: passed
  - GitHub checks: passed
```
````

未完成 commit、push、ready PR 或 CI 未成功时，不得宣称可验收。验证通过后以 `intent: accept` 进入目标验收；目标 Seat 由本线程编制和路由规则决定。

合入前必须同时具备结构化 review 放行与 CI 成功证据。自审必须显式标记，不能伪装成换席审查。
