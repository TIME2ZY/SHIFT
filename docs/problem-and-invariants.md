# SHIFT 解决的硬问题与当前边界

> 这份文档回答两个外部最常见的质疑：
>
> 1. 这是不是只是把几个 Agent CLI 摆在同一个聊天窗口里？
> 2. 除了作者自己，谁会用？
>
> 状态以当前实现为准。未落地能力标为后续工作，不得写成已有成果。
> 实现地图见 [`architecture-map.md`](./architecture-map.md)，契约见 [`decisions/`](./decisions/)。

## 1. 真正要解决的问题

SHIFT 不提供模型，也不替代各家 Coding Agent。它针对的是已经在本机同时使用多个 Agent 时出现的**工作流断裂**：

| 表面现象 | 背后的系统问题 |
| -------- | -------------- |
| 要在终端之间复制上下文 | 任务状态没有单一权威源，重启或换 Agent 后无法恢复因果 |
| Agent 说“做完了” | 完成条件不可核验，无法绑定 commit / PR / CI |
| 两个 Agent 同时改同一工作区 | 缺少会话级隔离，diff 互相污染 |
| 交接后下一轮忘掉约束 | Memory 与调度事件混在一起，或把完整聊天史硬塞进窗口 |
| CLI 升级后输出对不上 | 异构 Provider 事件没有最小契约，未知事件被猜成成功 |

因此 SHIFT 的产品命题不是“接入四个模型”，而是：

> 在本地、异构、不可控的 Agent Runtime 之上，提供可恢复的任务线程、只消费一次的交接、证据驱动的阶段门禁，以及可裁剪的上下文。

## 2. 复杂度在哪里（面试与 Review 应看这些）

复杂度不在 Agent 数量，而在下面几组不变量。每条都对应代码入口和测试，而不是口号。

### 2.1 异构 Runtime 适配，而不是抹平差异

Codex CLI、Antigravity/Gemini CLI、Grok ACP、OpenCode CLI 的启动参数、Session 恢复、权限回调、用量字段和终态信号都不同。Adapter 只统一上层最小事件：`run / text / tool / progress / usage / file`。未知事件记为 diagnostic，关键事件缺失则显式失败，不猜测映射成业务成功。

### 2.2 SQLite 是唯一在线真相源

Thread、Message、Trace、Invocation、Handoff、批准状态由 SQLite 事务仲裁。进程内 Map 不能作为恢复源；JSONL 只做审计导出。FTS / 向量 / 审计文件都是可重建读模型，禁止反向覆盖权威事实。

### 2.3 Invocation 与 Trace 必须进入终态

有流式文本不代表完成。Invocation 只有 `completed | failed | aborted`。请求结束和服务启动都会 reconcile 遗留 active 状态；不允许把不完整执行伪造成功。消失的外部 CLI 进程不能被复活。

### 2.4 Handoff 是带生命周期的业务实体

交接记录来源 Invocation、目标 Agent、意图、内容哈希、接收与完成状态。同一来源到同一目标最多一个 accepted flight。accept / bind / complete 由 repository 仲裁，避免重复消费。

当前边界：accept 后若进程在入队前崩溃，启动时把无法继续的 pending 显式失败收口。完整的 SQLite-backed dispatch outbox（崩溃后可安全续派）仍是后续工作。

### 2.5 阶段门禁用平台证据，而不是 Prompt

讨论、实现、审查、交付的跃迁由方案 hash、结构化 review、Git/PR/CI 状态驱动。对当前实现 Provider（Grok ACP），未批准方案时修改类工具会被权限回调拒绝。不要把这一点扩大成“所有外部 CLI 都已有同等强沙箱”。

### 2.6 上下文是预算问题，不是日志回放

Memory 与 Handoff 分开建模。Recall 以 FTS 为稳定路径、向量为可选补充，RRF 融合后再按来源配额和 Token 预算裁剪。接近 Provider 安全阈值时由平台 seal generation，而不是等各家内部压缩先发生。

### 2.7 代码隔离与交付证据链

每个需要改代码的会话使用独立 Git Worktree。交付不接受 Agent 自述；核验 clean worktree、真实 commit、分支、PR 与 CI，再对照用户目标和批准方案。代码合理不等于需求正确，因此仍保留最终验收。

## 3. 谁会用：当前事实，不包装成市场验证

| 问题 | 当前事实 |
| ---- | -------- |
| 第一用户 | 作者本人：同时订阅并使用多个 Coding Agent，用 SHIFT 推进本仓库自身的设计、实现、审查和交付 |
| 目标用户 | 已经在本机安装并登录多个 Agent CLI、需要跨 Agent 续工和验收的个人开发者 |
| 非目标 | 没有本地 CLI 的纯 API 用户；需要多租户、远程调度、企业 SSO 的团队平台 |
| 公开采用 | 仓库公开，但没有可对外报告的活跃用户数、留存或付费数据 |
| 效果证明 | 有状态机 / 恢复 / handoff 幂等测试，以及小规模 Memory/Recall 回归集；**还没有**统计意义上的“多 Agent 优于单 Agent”结论 |

需求来源是高频个人痛点，不是调研问卷。可以诚实说：

- 痛点真实：多 Agent 并行开发已经发生，缺的是状态、交接和验收；
- 验证不足：还没有外部活跃用户和对照实验；
- 下一步验证：用固定 Issue 集对比单 Agent / 自审 / 多 Agent，公开失败案例，而不是先扩功能。

不要把 star 数、截图或“支持四个 Agent”说成市场需求已经成立。

## 4. 和现成工具的边界

| 工具类型 | 已能做的 | SHIFT 额外约束的 |
| -------- | -------- | ---------------- |
| IDE 多终端 / tmux | 并排跑多个 CLI | 统一线程、恢复、终态、交接幂等 |
| 各家 Agent 自带会话 | 单 Runtime 内续聊 | 跨 Provider 的规范事件和 Session 关系 |
| 多 Agent 编排框架 | 调模型 API、写 Prompt 流水线 | 接入真实 Coding Agent Runtime，并用 Git/PR/CI 做门禁 |
| 纯 Chat UI | 展示流式文本 | 把文本、工具、进度、文件变更和 durable 终态分成不同事实 |

## 5. 后续只补会改变可信度的缺口

按可靠性而不是功能清单排序：

1. SQLite-backed dispatch outbox：accept 与出队在同一事务，崩溃后可续派而不是只能失败收口。
2. SSE event cursor：重连先回放缺失规范事件，再接实时流。
3. 扩大真实 Query / Issue 评测，并做单 Agent vs 多 Agent 对照。
4. 统一 Capability Policy；无法提供权限回调的 CLI 降级到更强隔离。

新增 Agent、云端多租户或“自动证明业务价值”不在当前范围。
