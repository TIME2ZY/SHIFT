---
name: requesting-review
description: Review 请求必须自检 — 禁止未自检就请求 review
triggers:
  - "请 review"
  - "帮我 review"
  - "帮我看看"
  - "review 一下"
  - "帮忙检查"
  - "review this"
---

# Review 请求必须自检

**针对的弱点**：AI 过度自信 + 想讨好 — 可能把有问题的代码直接交给 reviewer。

## 核心规则

```
BEFORE 请求 review:
  1. INSTALL: 干净 worktree 使用 npm ci 安装依赖
  2. VERIFY: 运行 npm run verify:pr
  3. SELF-CHECK: 逐条自检代码
  4. FIX: 发现的问题先自己修
  5. CONFESS: 修不了的写进 Open Questions
  6. REQUEST: 确认自检齐全后才能请求 review
```

## Review 请求内容要求

请求 review 时必须附带：

| 项目 | 内容 |
|------|------|
| 验证结果 | 附上 `npm run verify:pr` 的通过结果；失败时不得请求 review |
| 自检结果 | 我已经检查了 X/Y/Z，发现并修复了 A/B |
| 已知问题 | 以下问题我知道但不确定怎么修 |
| 需要重点关注 | 以下部分需要 reviewer 特别留意 |

依赖和安全检查约定：

- 干净 checkout/worktree 必须使用 `npm ci`，不要使用会改动锁文件的 `npm install`。
- `npm audit` 单独执行并报告；在现有漏洞基线清理完成前不作为 `verify:pr` 的阻塞项。
- 不自动执行 `npm audit fix`，依赖升级应作为明确、可评审的改动处理。

## 禁止行为

- ❌ 没有自检就直接请求 review
- ❌ 没有提供 `npm run verify:pr` 通过结果就请求 review
- ❌ "帮我看看这段代码" 而没有附带任何上下文
- ❌ 隐藏已知问题，等着 reviewer 发现

## Block 场景

```
❌ "帮我 review 一下这段代码"（只有代码，没有自检/上下文）
   → BLOCK: 请先自检，补充上下文后再请求 review
```

## 通过场景

```
✅ "自检结果: 已检查空指针/边界/并发安全，修复了 2 处空指针
    验证结果: npm run verify:pr 全部通过
    已知问题: 第 45 行的错误处理不确定是否完整
    重点关注: 数据库事务边界
    @OpenCode 请 review"
```
