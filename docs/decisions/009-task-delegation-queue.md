---
title: "ADR-009: Task Platform and Built-in Team Runtime"
status: accepted
decision_id: ADR-009
created: 2026-10-02
scope: task, frozen plan, executable nodes, team runs and acceptance
---

# ADR-009：任务平台与内置团队运行时

## 产品决定

SHIFT 是面向已配置本机 Agent CLI 的个人用户的任务委托平台。用户描述目标，主 Agent 整理可编辑计划，平台选择能力与团队。提交冻结范围；执行期间只能停止，需求变化创建关联草稿。第一阶段建立框架并接入软件交付团队；材料、Windows 桌面和发布分别在后续阶段实现。

本决定替代此前“一个 Thread 就是一个委托、在 collaboration_tasks 上附加队列”的实现，也覆盖 ADR-007 中将软件角色链作为平台通用模型的部分。ADR-007 的软件证据协议保留在 software_delivery 团队内部。

## 独立对象与权威入口

SQLite 是唯一在线业务真相源。task_repository 独占 Task、Plan、Node、TeamRun、Artifact、Acceptance 与规范事件的写入。Task 使用独立 UUID，可无 Project、无 Thread 存在。Thread 只承担准备对话或某次 TeamRun 的观察记录。Project 是可选输入上下文；软件团队执行时才需要 Git 工作空间。

Task：id、parentTaskId、可选 projectKey、draft plan、revision、state、FIFO seq、preparationThreadId。状态 draft / queued / running / cancelling / completed / failed / cancelled。
Plan：提交时生成独立 id、来源草稿 revision、不可变目标/交付物/条件、规范内容 hash。每个 Task 第一版只提交一次。
Node：稳定的计划内 id、顺序、workflowId、所需 capabilities、dependsOn、范围、交付物和验收条件；发布时实例化独立状态 pending / running / completed / failed / cancelled。提交前验证依赖存在且无环，并验证总体验收条件被分任务覆盖。
TeamRun：独立 UUID、task/plan/node、attempt、选择的成员与职责绑定、thread/trace 引用、started/terminal。唯一 (plan,node,attempt)，全局一个 active 槽。领取、尝试创建、节点转态与事件同事务。
Artifact：只存通用 kind、locator、contentHash、metadata、摘要及 run 归属，文件和 Git 内容仍以工作空间为准。
Acceptance：绑定 run 与其 artifact ids，判定及 verified / agent_reviewed 证据等级。平台仅接受 Team Runtime 返回的结构化成果，文本和 CLI exit 不能自行写 completed。所有节点验收通过才能完成 Task；平台不解释 commit/PR/CI。

## 分配与执行

Agent catalog 把已配置 Provider、可用性探测和适配器已知能力组成候选集；unknown 明确展示，不能冒充已探测 available。Team 定义声明 workflowId、能力要求、角色与执行函数。能力匹配和成员选择由平台完成，软件 Duty 列表仅存在于软件定义。第一版只有内置 software_delivery，对未知 workflow 明确拒绝，不开放自定义插件 UI。

主 Agent 输出有依赖与能力要求的执行计划，不指定具体 Agent。缺少材料时正文提问，Task 维持 draft/needs_input，界面通过消息只读投影展示反馈；没有计划围栏不当作执行失败。发布校验全部节点与可用成员并冻结选择。全局串行：先取最早 Task，再按依赖就绪和计划顺序领取节点，完成该 Task 后处理下一 Task。准备调用共享全局进程槽，草稿编辑和发布不占槽。

Scheduler 只处理通用运行结果、重试次数、墙钟期限、取消和恢复。软件 Team Runtime 内部调用现有单一 chatRunExecutor，复用 durable invocation、进程身份、SSE 和 handoff，并将软件证据转成通用成果。每次尝试有独立观察 Thread。同一 Task 的软件节点共用以 Task id 管理的工作树，串行积累修改；依赖输入为每个声明前置节点的 runId、冻结 Artifact（id/kind/locator/contentHash/metadata）与 Acceptance 回执。软件产物定位于工作树加不可变 commitSha，后续节点可据此复核原版本。跨 Task 隔离。

软件团队沿用方案、实现计划、review、delivery、accept 证据门禁；平台只能看通用 Acceptance。独立审查 Provider 优先，只有一个可用 Provider 时记录 solo_fallback。本阶段软件交付仍要求既有 Git/PR/CI 证据；没有远端时明确失败并保留代码，不伪造交付。

软件共享工作树的组合验收：每次尝试 baseline 固定此前已完成的软件节点 id；团队自己的冻结范围保持本节点目标，内部验收条件还包含这些节点原有条件，须在当前工作树重新核验。引用通过 PlanNode 只读投影得到，不复制合同；旧尝试的条件集合不会随之后节点完成而增长。通用平台回执仍只匹配当前节点条件，累计复查属于软件 Team 责任。

## 并发、失败与恢复

草稿更新/准备结果采用 expectedRevision；准备开始绑定 Thread 后采样 revision，结果必须 CAS 到同一 revision，用户期间的编辑优先。发布幂等键为 Task id 与来源草稿 revision，重复提交相同 revision 复用同一冻结 Plan，其他版本拒绝。回执使用按对象键排序的规范 JSON hash，键顺序变化可重放，内容或产物顺序变化显式冲突。取消意图唯一持久化在 Task.cancelling；Run/Node 仍为 running，表示正在等待进程收口。停止先 SIGTERM，再由既有 child-stream 的有界 grace 升级 SIGKILL，等待 close 与 durable 终态后收口 run/node/task，才释放槽。无法确认退出或退出持久化失败时保留可观察 recoveryBlocked，不因超时释放槽。取消待执行任务不启动子进程。

软件尝试记录 baseline（headSha、porcelain、目录、continue_workspace）。重试继续检查已有脏工作树，不自动 reset 用户或前次成果；提示明确避免重复外部副作用。失败尝试产物保留但无 Acceptance，不能作为后继输入；中断运行标记 unknownSideEffect，绝不自动重试。任何节点取消导致 Task 取消，未启动节点同时取消。默认有限重试只处理 Team 标识的可修复验收缺口；启动或外部执行失败不盲重试。进程中断将 active run、节点、Task 明确记失败，不重复未知副作用；未领取任务保持 FIFO。服务启动必须先核验遗留进程，未知身份阻止调度。

## 迁移和路径删除

v33 向前迁移独立任务表，旧委托只迁移为可查看的草稿或终态，不自动重跑旧提交。旧 display-only subtasks 的提交任务保留 legacySource（来源 Thread id 与历史结果）并标注迁移原因，原行快照进入离线 archive。来源只用于回看，不参与任务身份、队列或领取。移除 collaborationTasks.delegations、旧 orchestrator/team/progress 和 Session /runs 准备写入口。软件协作表只保存团队内部证据，通过 TeamRun/Node 的只读 join 获取冻结范围与选择，不复制平台合同或状态。清除 v32 队列字段与索引，保留运行服务 lease。

## 验证

验证 Task 可无 Thread/Project 创建、DAG 与条件覆盖、冻结/乐观锁/发布幂等、每节点独立 attempt、依赖成果传递、不同团队的通用完成、FIFO、有限重试、取消收口、故障恢复及软件真实证据桥接。替换旧包装语义测试，保留底层 invocation/handoff/SSE 回归。

回滚前停止服务并备份数据库；v33 删除旧队列列，不能仅回退运行代码。通过数据库备份与代码版本一起回滚，保留工作树成果。

## 第二阶段：材料整理与分析

接入内置 materials_analysis Team。用户在草稿中粘贴文字或选择 TXT/Markdown 文件；平台保存 UTF-8 材料快照及 SQLite 引用：去掉开头 BOM，将 CRLF/CR 转为 LF，SHA256 基于实际保存的规范化字节，行号从 1 开始按 LF 分行。输入限 20 份、单份 64 KiB、合计 256 KiB。添加/移除使用草稿 revision，提交时将输入 id/name/locator/SHA256 固定在 Plan；运行和关联任务均引用已固定版本，关联输入保留 ownerTaskId 与输入 id，读取严格核对原归属目录和版本；原文件不参与后续读取。无项目的准备会话和材料执行使用普通任务目录，并用 skipGit 按目录身份绑定，防止 SHIFT_HOME 位于 Git 子目录时向上解析到宿主仓库。软件 Team 才创建 Git 基线。

材料 Team 的 analyze、write、review 由平台按能力绑定成员。长提示词在既有执行器通过 stdin 管道传递，绕过 Windows 命令行长度上限；只读 Codex/Claude 同样通过 stdin 收材料。三个调用仍走既有 invocation executor，分别记录 workflow/role 绑定和 durable Trace；软件 Duty 可为空，与 workflow/role 互斥。软件专属技能、协作提示词、权限门禁、证据及 handoff 只对 software_delivery 生效。准备与材料调用使用明确的只读执行配置，不接受 CLI 交接；三个角色的推进属于 Team 内部执行，沿用同一 Task 槽、取消和恢复协议；调用前后、核验及写报告前后检查取消，异常必须停止并等待所属 executor 收口再释放槽。TeamRun.traceId 固定为首次调用，Acceptance 保存全部 traceIds，后续调用通过同一观察 Thread 归属尝试。优先选择不同成员复核，单成员回退显式记录。

材料源作为带行号的数据注入提示词，禁止将材料内的指令当成操作授权。Agent CLI 全部使用已支持的强制只读 Provider（Codex/Claude）；Codex 只读调用添加 skip-git-repo-check，支持没有 Git 仓库的任务目录；Agent 输出结构化报告，不直接写成果文件。write 返回带来源引用的段落，review 判断全部节点条件是否达成。平台在复核前检查所有引用 id、行号、原文片段和源文件 SHA256，任一无效就拒绝整份成果。平台确定性生成 Markdown，review 审查这份完整报告；接受后保存同一份字节，不在复核后筛选或改写结论。报告 SHA256 固定到 Artifact；Acceptance 为 agent_reviewed，机械检查结果另记入 evidence，不能把结论判断冒充 verified。

输入与成果文件内容是文件真相源，SQLite 只保存引用和冻结版本。未引用文件不形成业务事实；写文件后 CAS 失败可留下未引用文件，不能进入计划或成果读取。输入/成果读入口校验所属 Task、服务管理目录的真实路径、普通文件与哈希；拒绝目录穿越、符号链接越界和版本漂移。成果预览/下载只按 Task+Artifact id 读取，不接受任意文件路径。

schema v34 增加输入引用与 Plan 输入清单，并将 invocation binding 扩展为软件 Duty 或通用 workflow/role 的单一权威记录，不新增进程执行器或平台终态入口。第二阶段验收包含无 Project/Git 的真实材料委托、报告与引用、原材料保留、不同 Team 路由、取消/重启，以及原软件团队回归。Windows 桌面与发布仍为第三、第四阶段。
