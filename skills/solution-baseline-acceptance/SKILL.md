---
name: solution-baseline-acceptance
description: Codex 收敛方案（solution_baseline）与按最初用户目标做最终验收（final_acceptance）的过关模板
triggers:
  - "solution_baseline"
  - "final_acceptance"
  - "收敛方案"
  - "最终验收"
  - "intent: accept"
---

# 收敛方案与最终验收（Codex）

平台保存最初用户目标 hash，并校验 `solution_baseline` / `final_acceptance`。本 skill 给出完整可过关形状；hash 不匹配或缺证据时交接会被拒绝。

## 交给 Grok 之前（`intent: plan`）

收敛方案必须区分用户目标、选择的方案、非目标与逐项验收标准。不得自行改写平台提供的用户目标 hash。

````markdown
```solution_baseline
user_goal_hash: <平台提供的用户目标 hash>
summary: <Codex 收敛后的可行方案>
constraints:
  - <必须遵守的约束；没有则写 none>
non_goals:
  - <明确不做的内容；没有则写 none>
acceptance_criteria:
  - <逐项可验证的验收标准>
```
````

缺失或 hash 不匹配时，平台拒绝 `plan` 交接。

## 最终验收（`intent: accept`）

在 OpenCode 完成真实 commit、PR 与 CI 之后。对照「用户最初目标 + 收敛方案 + 验收标准」，不要用代码 review 结论替代目标验收。拒绝时说明目标偏差并退回。

````markdown
```final_acceptance
verdict: <accept|reject>
user_goal_hash: <平台提供的用户目标 hash>
solution_hash: <收敛方案 hash>
implementation_plan_hash: <实现方案 hash>
commit_sha: <40-char sha>
checks:
  - <验收标准> => <pass|fail>: <证据>
gaps:
  - <未满足项；全部满足时写 none>
```
````

只有所有标准都有 `=> pass: 证据`、无 gap、CI 成功且四个 hash 全部匹配，平台才进入 done。
