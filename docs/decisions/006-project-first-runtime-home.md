---
title: "ADR-006: Project-first sessions and user-level runtime home"
status: accepted
decision_id: ADR-006
created: 2026-08-09
amended: 2026-09-06
scope: project lifecycle, thread ownership, retrieval isolation, runtime home migration
supersedes: []
related:
  - 001-storage-truth-boundary.md
  - 005-memory-thread-only.md
  - ../memory-data-contract.md
---

# ADR-006：Project 一等化与用户级运行目录

## 状态

**Accepted — implemented**

运行目录迁移、Project 生命周期、Thread 绑定、检索隔离和前端项目导航均已完成。在线
composition root 只接受 `SHIFT_HOME/data` 下的 active clean epoch SQLite；不得恢复旧在线
数据库位置、无 Project 的会话创建路径或调用方选择 recall Project 的能力。

## 背景

落地前 `threads` 已保存 `project_dir` 和 `project_key`，但产品入口仍以全局会话列表为
中心：新会话默认绑定 SHIFT 源码目录，用户需要进入会话后修改目录，前端只按时间组织
会话。运行数据库、审计记录和 worktree 状态也位于仓库 `data/runtime`，使平台数据与
SHIFT 项目内容耦合。

SHIFT 的目标是编排多个本机 Agent 在多个本机项目中工作。Project 必须先于 Thread 成为
明确边界，否则会话展示、Invocation 工作目录、project-doc、FTS 和 vector recall 都可能
依赖“当前仓库”这一隐式全局状态。

## 决策

### 1. `SHIFT_HOME/data` 是唯一在线运行目录

`SHIFT_HOME` 是应用根目录，默认值为 `os.homedir()/.shift`。本次只占用其 `data/`
子目录；根目录保留给未来配置、Skill、Plugin 或其他明确能力。正式数据库固定为：

```text
SHIFT_HOME/data/shift.sqlite
```

在线运行数据、路径收口和一次性迁移规则以 ADR-001 §5.4 为准。项目源码、项目文档和真实
Git worktree 内容不迁入该目录。

### 2. Project 是 Thread 的必选 owner

`projects` 是 Project 存在性、规范目录、显示名、最近打开时间和归档状态的权威表。
`threads.project_key` 必须非空并引用一个 Project。新建 Thread 必须提交 `projectKey`；
后端从 Project 记录取得规范目录，不能信任前端同时提交的 `projectDir`。

Project 绑定在 Thread 创建时完成，随后不可更换。现有“先创建无项目会话，再修改项目
目录”的公开路径必须删除。Message、Invocation、context window、协作事件和 thread
Memory 继续通过 `thread_id` 归属；不得为 Project 旁路出另一套启动、流式、终态或持久化
流程。

### 3. 打开目录创建或恢复 Project

“打开项目”接收一个已存在的本机目录，解析 realpath 和规范路径后：

1. 活跃 Project 已存在：更新最近打开时间并返回；
2. 归档 Project 已存在：恢复原 Project 及其原有 Thread；
3. Project 不存在：创建 Project；
4. 目录不存在、不可读或不是目录：明确失败。

Git 仓库可以启用 Git/worktree 能力。无 Git 目录使用规范化绝对路径身份，仍可创建 Thread
并直接在本地目录运行 Agent；SHIFT 不执行隐式 `git init`。本次一个 Project 绑定一个主
目录，不增加多目录 Project、路径搬迁推断或远程项目。

### 4. Project 移除采用可恢复归档

普通产品操作命名为“从侧边栏移除”或“归档项目”，只设置
`projects.archived_at`：

- 不删除项目目录或文件；
- 不删除 Thread、Message、Invocation、Memory 或索引；
- 不逐个修改所属 Thread 的归档状态；
- 不允许在仍有 active Invocation 时归档；
- 从普通项目列表、普通会话列表、正常 Agent 执行和正常检索中排除；
- 可从归档项目入口恢复；
- 再次打开相同规范目录时恢复原 Project。

永久清除本地记录不是本次能力。未来如增加，必须使用独立名称、独立确认和事务级 purge，
不能改变本 ADR 的默认归档语义。

### 5. 项目隔离由后端强制

前端当前项目只是 UI 偏好，SQLite 才是 Project/Thread 所有权真相。任何会话、工作区、
Invocation 或 recall 请求都必须从可信 Thread 解析 `project_key`，并验证 Project 活跃；
不能单独相信前端提供的 Project 标识，也不能在缺少作用域时回退为全库查询。

检索分区固定为：

| 层                            | 作用域                                        |
| ----------------------------- | --------------------------------------------- |
| Product Memory                | 当前 `thread_id`                              |
| Message / Invocation evidence | 当前 `thread_id`                              |
| Project document / passage    | 当前 Thread 的 `project_key`                  |
| Vector                        | `thread:<threadId>` 或 `project:<projectKey>` |

归档 Project 的数据保留，但不得参与正常 recall。归档管理和恢复可以使用显式管理查询，
不能借此扩大 Agent 正常检索范围。

### 6. Project 文件仍由项目拥有

SHIFT 不拥有通用的 `docs` 目录。`README*`、`AGENTS.md`、`docs/**` 等仅是默认只读发现
候选；SHIFT 不自动创建、覆盖或搬运这些文件。跨会话的正式项目知识仍以项目 Git 文件为
真相，SQLite 中的 project-doc、passage、FTS 和 embedding 只是按 `project_key` 隔离的
可重建投影。

本次不增加系统目录中的 Project Memory 或本地项目笔记，避免产生第二个跨会话项目知识
真相源。

### 7. 现有数据只迁移为 SHIFT Project

本次迁移前提是仓库旧 `data/runtime/shift.sqlite` 中全部业务数据均属于 SHIFT 项目。
离线迁移工具必须：

- 用当前 SHIFT 仓库规范身份创建或确认 Project；
- 将空绑定或等价 SHIFT 路径的历史 Thread 绑定到该 Project；
- 发现明确指向其他规范路径的 Thread 时失败；
- 保持所有业务 ID、消息正文、Invocation 终态和 Memory ownership；
- 校验完成后原子发布到 `SHIFT_HOME/data/shift.sqlite`；
- 将旧运行数据移入新目录下的可恢复备份，且不再进入在线读取。

## 公开路径变化

目标 API 语义为：

```text
GET  /api/projects
GET  /api/projects?archived=true
POST /api/projects/open
POST /api/projects/:projectKey/archive
POST /api/projects/:projectKey/restore
GET  /api/projects/:projectKey/sessions
POST /api/sessions { projectKey }
GET  /api/sessions/:threadId/workspace   # 后端 worktree 状态；Web 已无 Workspace 页
```

以下旧语义已删除，不得作为兼容层恢复：

```text
GET  /api/project
POST /api/project
POST /api/sessions {}              # 无 Project 创建
setSessionProjectDir               # Thread 创建后换项目
```

## 主链路影响

主链路只在入口增加 Project 守卫：

```text
打开活跃 Project
→ 创建并绑定 Thread
→ 用户发送消息
→ 启动原有 Invocation
→ 原有 SSE text/tool/progress
→ 原有 completed/failed/aborted 终态
→ 原有 SQLite 权威事务
→ 按 Thread 和 Project 恢复
```

Invocation 状态机、SSE 协议、durable terminal transaction、handoff 一次消费和消息写入
入口不增加第二套实现。Project 归档遇到 active Invocation 时返回冲突，不静默改变终态。

## 后果

### 正面

- 平台运行数据不再污染 SHIFT 仓库；
- 多项目会话、执行目录和检索边界一致；
- 无 Git 项目可以直接使用；
- Project 移除可恢复，不因 UI 操作丢失历史；
- Thread 创建入口和项目绑定路径更少。

### 代价

- 首次升级必须停止服务并执行一次离线迁移；
- 前端必须先选择或打开 Project 才能创建 Thread；
- 项目目录移动后本次实现不会自动猜测新位置；
- 归档数据继续占用本地空间，永久清理需要未来独立设计。

## 非目标

- 多目录 Project；
- 远程项目或多租户；
- 自动初始化 Git；
- 自动创建项目 `docs` 或 `.shift` 文件；
- 系统级 Project Memory；
- 每 Project 一个 SQLite；
- 永久删除 Project 数据；
- 同时支持仓库旧库与用户目录新库。

## 验收不变量

1. 在线服务只打开 `SHIFT_HOME/data/shift.sqlite`；
2. 所有新 Thread 都有非空且有效的 `project_key`；
3. Thread 创建后没有公开的换 Project 路径；
4. Project A 的 Message、Memory、project-doc、FTS 和 vector 不会命中 Project B；
5. 归档 Project 不参与普通展示、执行或召回，恢复后历史完整；
6. 无 Git Project 可以完成不使用 worktree 的主链路；
7. 迁移失败不产生可启动的半成品新库；
8. 迁移完成后删除或移动仓库旧库不影响启动；
9. 实现不存在双数据库读写或旧路径 fallback。
