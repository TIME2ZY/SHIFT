---
title: "ADR-009: Task Delegation and Durable Execution Queue"
status: accepted
decision_id: ADR-009
created: 2026-10-02
scope: delegation preparation, frozen contracts, team binding, queue and delivery
related:
  - ./001-storage-truth-boundary.md
  - ./002-multi-agent-reliability-contracts.md
  - ./007-seat-duty-evidence-workflow.md
---

# ADR-009：任务委托与持久执行队列

## 产品与边界

SHIFT 面向已经配置本机 Agent CLI 的个人用户。用户委托目标，平台组织执行。
第一阶段实现通用委托骨架，并接入内置 software_delivery 工作流；材料分析、桌面封装和发布留在后续阶段。

准备期由主 Agent 整理目标、交付物、验收条件及可见分任务，用户可编辑草稿。
提交是建立初始委托合同，不是运行中的人工方案批准。
提交后冻结合同，平台独立选择、记录 Team；内部 discuss/plan/implement/review/fix/deliver/accept 继续依 ADR-007 推进。
用户不能修改执行中目标、增加审批闸门或自行写入完成；需求变化建立关联新委托。

## 权威对象与状态

每个委托对应一个内部 Thread。历史和新委托以 parentThreadId 关联，不复用已提交 Thread 的目标。
项目是可选上下文：没有选择项目时，平台建立独立任务目录并绑定内部 Project，Thread 的目录绑定约束继续有效。
软件任务默认在任务专属 Git worktree 执行，用户提供的源项目保持原有目录绑定。

现有 collaboration_tasks / collaboration_task_events 是唯一任务写入路径。
delegation_state 独立表达 draft | queued | running | cancelling | completed | failed | cancelled。
原 task_status 继续表达 Agent 证据验收 active | waiting_human | accepted | rejected，
它不是第二套执行调度状态；completed 必须依据 accepted 及真实完成证据产生。

草稿 contract 包含 workflowId、goal、deliverables、acceptanceCriteria 和带稳定 id 的 subtasks。
提交时，在同一 SQLite 事务中检查 expectedRevision、冻结合同及 hash、保存 Team 和 FIFO 序号、写规范事件。
已提交合同不可由 registry.save、task_goal、旧 HTTP run 请求或模型输出覆盖。
内部技术方案和修复可以变化，但不能扩大合同或改变可见分任务。
同一 task 的重复提交只复用原队列记录。

## Team 与调度

主 Agent 提出任务和能力需求，平台负责校验并选择 enabled、可路由的本机 Seat。
已检测 available 优先，unknown 明确记为尚未验证；不可用、未登录或禁用 Seat 不参与。
Team 保存每个 Duty 的 Seat/Provider 绑定和选择依据；能选择不同审查 Seat 时优先分离，
只有一个可用 Seat 时明确记录 solo_fallback。不新增 Provider 或模型服务。

全局 FIFO 一次执行一个委托。领取通过 SQLite immediate transaction 及唯一 active slot 仲裁，
内存仅唤醒消费者。内部 handoff worklist 继续承担一次委托内的因果调度，不能用作全局队列。
发布与执行只走该调度入口；已有 HTTP/SSE 和 durable invocation 起止复用，不建立另一套 CLI executor。
旧发送消息直接执行路径收窄为准备期主 Agent 分析，发布后拒绝新消息改变任务。

## 失败、停止与恢复

有界修复只针对冻结范围内的证据缺口，平台默认重试次数和墙钟期限。
缺材料、范围变化、达到期限或重试耗尽时明确失败，保留成果，支持关联新草稿。
取消 queued 任务直接持久化 cancelled；运行任务先写 cancelling，停止进程并等待已有终态闭环后写 cancelled。
准备期分析同样用既有 durable started/terminal 记录，但不能触发 handoff 或进入实际实现。
准备期仅选择目前能强制只读的 Codex 或 Claude Code：Codex 使用 read-only 沙箱，Claude Code
限制 Read/Glob/Grep 并禁用外部 MCP 配置；其他 Provider 可参与提交后的执行 Team。
旧 /runs 请求不再指定执行席位，响应明确返回平台选择的 selectedAgent 和 purpose=prepare。

第一阶段的软件交付沿用现有 commit/PR/CI 验收证据。独立任务目录没有远端时仍能保留代码成果，
但不伪造 PR/CI 或将其标记为已交付；本阶段不引入另一套本地完成口径。

启动先收口旧 invocation/trace/handoff，再将遗留 running/cancelling 委托记为中断失败或取消；
不伪造成功、不自动重复未知外部副作用。queued 保留 FIFO 顺序。
进程收口失败或身份不明必须可观察，不能把仍可能写文件的执行当作已安全停止。

## 验证与路径收口

覆盖重复提交、过期草稿、合同冻结、不可用成员、单全局执行槽、FIFO、取消、
提交与启动之间的中断、已开始运行的中断、无证据不能完成以及重启后排队保留。
保留 invocation/handoff/SSE 可靠性回归；替换保护旧直接执行接口的测试。
架构地图在实现完成后同步唯一写入口与调用路径。

## 回滚

数据库迁移是向前兼容的附加字段，回滚运行代码不删除任务或成果；
旧代码不应处理已有 queued/running 任务，回滚前须停止并收口运行。
通过数据库备份恢复整体版本，不双写或依靠 JSON 仲裁。
