# Architecture Map — 当前实现与权威路径

> **状态：** 当前实现地图
>
> **范围：** 主链路、权威写入口、在线/离线边界与交付门禁。
>
> **依据：** `AGENTS.md` 主链路、目录职责、真相源与架构实现地图维护要求。
>
> **维护：** 代码改变本文件所列路径、入口、边界或结论时，必须在同一 PR 中同步更新。

---

## 1. 目的

持续回答四个问题，供实现、review 和交付验收使用：

1. 四类业务事件现在从**哪些入口**写入？
2. 哪里存在**双路径 / 双语义**？
3. 哪些模块是**热路径**，哪些可**归档/迁出 `src` 热依赖**？
4. 协作交付通过哪些证据和门禁闭环？

---

## 2. 主链路与代码锚点（概览）

```text
HTTP createServer (src/server/index.js)
  ├─ project-routes     → project-repository (open / list / archive / restore)
  ├─ session-routes     → sqlite-session-service (Project-bound thread CRUD + collaboration snapshot)
  ├─ chat-routes        → start/finish Trace + start/stream/finish invocation + finalize A2A
  ├─ callback-routes    → mid-run postMessage / MCP 私有 HTTP bridge / (A2A finalize)
  ├─ memory-routes      → 读为主（list/search 等）
  └─ storage-routes     → 审计/运维向

Web App (web/src/app/App.tsx)
  ├─ projects feature  → /api/projects（选择、打开、归档、恢复）
  ├─ sessions feature  → /api/projects/:projectKey/sessions + Project-bound create
  ├─ collaboration feature → GET /api/sessions/:id/collaboration（任务/验收卡投影）
  │                         + POST /api/sessions/:id/collaboration/acceptance（Human 最终决定）
  └─ observability feature → 独立审计页（占用原工作区导航位置）

持久化核心：
  durable-recorder  → trace_runs + invocations + events + (assistant-final 原子 finish)
  sqlite-session-service → threads + messages (appendToSession)
  message-persistence.appendMessage → messages 表 + recall 投影
  event-store → invocation_events + outbox(JSONL 审计)
  memory-service → memories 表（产品记忆）
  handoff-repository → durable accept / bind / complete / restart reconcile
  observability-repository → live Trace completeness + qualified Handoff/Memory metrics
  execution-read-model → Session-scoped Trace / Invocation / Handoff durable timeline
  collaboration-read-model → Session-scoped 任务卡、Seat/Duty 与证据投影（只读，不回写）
  thread-seat-repository → Thread enabled Seat 配置与 chat/A2A 目标解析（schema v30）
  invocation-duty-binding-repository → Invocation start 同事务写入的不可变 DutyBinding（schema v30）
  memory-capture → 协作事件（handoff-captured 等），非产品记忆行
  recall-service → 从可信 Thread 解析活跃 Project，再查询 thread / project 分区投影
```

| 主链路步骤         | 主要代码                                                            |
| ------------------ | ------------------------------------------------------------------- |
| 1 打开 Project     | `project-repository.openDirectory` ← project-routes                 |
| 2 建 thread        | `sqlite-session-service.createSession({ projectKey })`              |
| 3 Trace start      | `durable.startTrace` ← chat-routes                                  |
| 4 用户消息         | `appendToSession` ← chat-routes                                     |
| 5 start invocation | `durable.startInvocation({ traceId, dutyBinding })` ← chat-worklist |
| 6 SSE 流式         | chat-routes + child-stream / ACP；事件 `appendInvocationEvent`      |
| 7 终态             | `completeInvocation` 后 `completeTrace`                             |
| 8 消息/事件 SQLite | appendMessage / event-store / finishWithAssistantMessage            |
| 9 恢复             | SQLite threads/messages/trace_runs/invocations                      |
| 10 handoff         | **见 §3.2**（finalize 已统一，触发与 hop 生命周期仍分叉）           |

---

## 3. 写路径清单（权威意图 vs 实际入口）

### 3.0 Trace request 生命周期

| 步骤      | 权威写入口                              | 实际调用方                                           | 落库                                        |
| --------- | --------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| start     | `durableRecorder.startTrace`            | `chat-routes` 在可信 Session 校验后、异步准备前      | `trace_runs` active row + request attempt   |
| bind root | `traceRunRepository.bindRootInvocation` | `durableRecorder.startInvocation` 内部               | `trace_runs.root_invocation_id`             |
| finish    | `durableRecorder.completeTrace`         | `chat-routes` 准备失败、执行异常或 invocation 收口后 | completed / failed / aborted + 统一 outcome |

Trace 与 Invocation 通过 `invocations.trace_id` 绑定。同一 client turn 的重试使用独立、单调
`request_attempt`；完成态要求不存在 active invocation，且 completed 必须存在 durable
assistant-final。`recovery-drill` 将 `trace_runs` 纳入权威表快照并检查跨 thread 与终态因果。

### 3.1 Invocation 生命周期（start / event / finish）

| 步骤                | 意图上的权威写入口                                            | 实际调用方                                                                                                                                         | 落库                                                                                           |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| start               | `durableRecorder.startInvocation`                             | **仅** `chat-worklist`（含 retry 再 start）                                                                                                        | 同事务写 `invocations` + 唯一 `invocation_duty_bindings` + `invocation-start` event            |
| 流式事件            | `durableRecorder.appendInvocationEvent` / `eventStore.append` | chat-routes 流循环；callbacks 记 callback-post/outcome；a2a-finalize 记 route 事件                                                                 | `invocation_events` + outbox                                                                   |
| **调度终态（B-1）** | **`durableRecorder.completeInvocation`**                      | **chat-routes 全部产品终态**（`reason`: assistant-final / aborted / provider-failed / empty-under-seal / empty-emergency / stream-handler-failed） | 有 `message` → 原子 finish+assistant-final（成功或失败/中止时已有正文）；无 `message` → 仅终态 |
| 底层（模块私有）    | `finishInvocation` / `finishWithAssistantMessage`             | 仅 `completeInvocation` 内部                                                                                                                       | 同上                                                                                           |
| 孤儿收口            | `reconcileThreadActive` → `forceTerminalInvocation`           | chat-routes 请求结束 `finally`                                                                                                                     | 强制 `failed`/`aborted`（非产品成功路径）                                                      |
| 写失败兜底          | `forceFailInvocation`                                         | durable-recorder 内部 / 调用约定                                                                                                                   | 避免长期 `active`                                                                              |

**结论（终态）— B-1 已落地（2026-08-07）：**

- 调度器面对的唯一写入口 = `completeInvocation({ invocationId, code, signal, reason, endPayload, message? })`。
- 底层 `finishInvocation` / `finishWithAssistantMessage` 仅为模块私有实现，公开 recorder 不再导出。
- 分支决策（何时带 message、何时 aborted）仍在 chat-routes；B-1 收口的是**写入口**，不是把业务 if 全部下沉（避免夹带行为变更）。
- Codex 正文权威：中途 `agent_message` 只发 `commentary.delta`；`turn.completed` 把末条
  `agent_message` 提升为 `text.delta`；`finish()` 仅在尚未提升时读 `--output-last-message`。
  失败/中止若已有 `text.delta`，`completeInvocation` 仍带 assistant-final，handoff 仍只在
  成功路径解析正文。
- Provider 空闲超时只 terminate 一次；Windows 用 `taskkill /T /F` 杀掉进程树。超时
  `console.error` 不得重复刷 stderr，以免上层把终止日志当成 child 活动。
- Callback **仍不** finish invocation；孤儿 reconcile 仍走 force 终端 API。
- 流式回调（`child-stream` 的 onEvent / onStderr / 管道 error）失败不会以 uncaughtException
  击穿进程：`runChildStream` 捕获后停止子进程并在结果上携带 `streamError`。chat-worklist 在
  `flushAll`、usage 写入和 empty-emergency replay **之前**检查该错误，转为
  `stream-handler-failed`（`failureStage: stream_handler`）；流结束后的 persist flush 抛错
  同样收口为该终态，不落入 `request-error-orphan`，也不再开一轮 invocation。
  `eventStore.append` 与 durable-recorder 使用同一 `withSqliteBusyRetry` 锁竞争重试策略；
  重试耗尽仍显式上抛。

---

### 3.2 Handoff / A2A 消费

| 步骤                   | 意图上的权威入口                                         | 实际                                                             | 持久性                                                    |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 解析 fence             | `agents/handoff.js`                                      | finalize 内 `selectCanonicalHandoffMatch`                        | 无                                                        |
| Seat/Duty 解析         | `duty-routing.js`                                        | 初始 chat 与 finalize；仅从 Thread enabled Seats 选目标          | 读取 `thread_seats`；DutyBinding 随队列因果传递           |
| 策略                   | `handoff-policy.js`                                      | finalize 内 `decidePolicy`；禁用/缺失 Seat 在所有模式下拒绝      | 无                                                        |
| 用户确认预览           | `handoff-confirmation.js`                                | finalize 生成可编辑摘要；chat 请求等待确认、取消或超时           | 请求内存，未确认不是业务事实                              |
| 幂等 accept            | `durableRecorder.acceptHandoff`                          | finalize 内                                                      | SQLite `handoffs`，唯一 accepted flight                   |
| 入队下一 Seat          | `worklist.push` → `markHandoffEnqueued`                  | finalize 内；队列项因果携带不可变 DutyBinding；确认失败撤销 push | 请求内存 worklist + SQLite `enqueued_at`                  |
| 捕获 handoff 协作事件  | `memoryCapture.captureHandoff`                           | finalize 内                                                      | event-store `handoff-captured`（**不是** product memory） |
| 触发 finalize          | `finalizeA2ARoutes`                                      | **双触发：** chat 回合结束 + callback `postMessage`              | —                                                         |
| 目标 hop bind/complete | `durableRecorder.startInvocation` / `completeInvocation` | chat-worklist 传 `handoffId`；recorder 与 invocation 同事务写入  | SQLite `handoffs`                                         |
| 协作 phase / plan gate | `collab-task-registry`                                   | chat 流前检查；callback 侧 plan/workflow evidence                | SQLite repository（若注入）+ 进程逻辑                     |
| 路由诊断事件           | `appendRouteEvent`                                       | EventStore → else durableRecorder.**无 transcript 双写**（B-2）  | SQLite events                                             |

**结论（handoff）— durable 0B-2 已落地：**

- Receive Bundle 把 Structured Handoff 当后继续工包（权威）；原文附录非权威且预算收窄。
- `implement/review/fix/deliver/plan` 缺 `files`/`evidence` 记入 `missingRecommended` 并打续工不足 banner，不因此把 `ok` 打成 degraded，也不新开顶层字段。
- 解析→策略→预览确认→accept→enqueue 仍统一在 `finalizeA2ARoutes`；确认后继续调用唯一的
  `acceptHandoff` 写入口，`enqueued_at` 只在 worklist 实际追加后确认。
- 待确认预览仅存在于服务进程内存；取消、超时、源请求停止或服务重启都会释放它，不创建
  `handoffs` 行或目标 invocation。服务重启丢失预览不会伪造已交接事实。
- A2A 固定 Agent ID/岗位 allowlist 已退出路由策略；明确 mention/handoff 仅能命中当前 Thread 的
  enabled Seat，目标未启用时不降级、不静默改派。Duty 由 handoff intent 确定，单独改变 Duty 不换 Seat。
- accept、duplicate、binding 和 terminal 均由 SQLite repository 仲裁；旧进程内 registry 已删除。
- target Invocation start/bind 与 Invocation terminal/Handoff terminal 各自在同一事务提交。
- 服务启动按 active Invocation → pending Handoff → active Trace 顺序收口崩溃遗留状态，
  Invocation 终态与 `invocation-end` 同事务提交，不补造成功。
- 热路径去掉 transcript dual-write（callback 诊断事件同样）。

---

### 3.3 Message 持久化

| 场景                    | 入口函数                                            | 文件                   | messageType                          |
| ----------------------- | --------------------------------------------------- | ---------------------- | ------------------------------------ |
| 用户 / 系统 / A2A 通知  | `appendToSession` → `appendMessage`                 | sqlite-session-service | `user` / `a2a-*` / `system-notice`…  |
| 助手终态正文            | `completeInvocation({ message })` → `appendMessage` | durable-recorder       | `assistant-final`                    |
| Callback 中途 assistant | `appendToSession`                                   | callbacks              | **`assistant-callback`（B-3 显式）** |
| 物理 insert             | **仅** `message-persistence.appendMessage`          | 热路径                 | + recall upsert                      |

**结论（message）— B-3 已落地（2026-08-07）：**

- 契约写在 `message-persistence.js` 头部；`MESSAGE_TYPES` 再导出。
- Callback **必须** `messageType: "assistant-callback"`，不得冒充 final。
- 守卫测试：`tests/storage/message-write-path.test.js` 禁止 server/agents/session 直接 `.messages.append`。
- Legacy 文件格式导入器已退役；在线与现存离线维护能力均不再通过该入口直写 message repository。
- 已删除仅供测试/兼容使用的 `durableRecorder.mirrorLastMessage` 公开入口；在线消息只保留上述两类
  用例入口并共享同一个物理写入口。

---

### 3.4 Memory 写入

| 类型                             | 入口                                                                     | 落点                                                                              | 调用方                                            |
| -------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| **产品记忆**（decision/fact 等） | `memoryService.writeMemoryCandidate` → `captureOnce` → `memories.create` | `memories` + embedding 入队                                                       | `shift_context` MCP → callback-routes 私有 bridge |
| **通用 capture API**             | `memoryService.capture` / `captureOnce`                                  | 同上                                                                              | 服务内部                                          |
| **Handoff 协作事件**             | `memoryCapture.captureHandoff`                                           | **仅** `handoff-captured` **事件**                                                | a2a-finalize                                      |
| **Window seal 事件**             | `memoryCapture.captureWindowSeal`                                        | `window-sealed` 事件（结构化续工包：goal/files/errors/next_action + 短 snapshot） | seal 路径；下一轮 bootstrap Digest 注入           |
| Recall / FTS / embedding         | 派生                                                                     | recall 表 / 向量                                                                  | 投影只读查询为主                                  |

**结论（memory）— B-4 已落地（2026-08-07）：**

- window-sealed 写入结构化续工包（goal / files / errors / next_action + 短 snapshot），由下一轮 `buildDigest` 注入；紧急密封也走平台拼包，不另调模型。
- `createMemoryCapture` **拒绝** `memoryService` 参数（防半接线）。
- composition root 只传 `eventStore`；注释标明产品记忆走 `writeMemoryCandidate`。
- 模块头文档区分 collaboration event vs product memory 行。
- Agent 面向的 Memory / Recall 公开工具只有 `shift_context` MCP 的 `memory_write`、
  `memory_evidence_list`、`recall_search`；`callback-client` 不再提供 Memory 命令。
- 同一 `shift_context` 还提供只读 `list_platform_skills` / `load_platform_skill`，
  走 `src/server/skills.js` 读取仓库 `skills/*/SKILL.md`，不经过 callback HTTP，
  也不是第二套 Skill 权威源。
- `scripts/shift-context-mcp.js` 使用 token 绑定的私有 HTTP bridge：
  `/api/callbacks/memory-write`、`/api/callbacks/memory-evidence`、
  `/api/callbacks/recall-search`。它们不是第二套 Agent 公开语义，最终仍进入
  `writeMemoryCandidate` / `recallService`。
- 已删除旧 `/api/callbacks/memory-upsert`、`/api/callbacks/session-search` 和相应客户端命令，
  不保留 callback fallback。

#### 3.4.1 Provider MCP 接入

所有 Provider 共用 `agents/shift-context-mcp-config.js` 中的 stdio descriptor，凭据只由当前
invocation 的 `SHIFT_*` 环境传入：

| Provider    | 唯一接入方式                                                    | 配置生命周期                                     |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------ |
| Codex       | CLI `mcp_servers.shift_context.*` 参数                          | invocation                                       |
| OpenCode    | `OPENCODE_CONFIG_CONTENT.mcp.shift_context`                     | invocation                                       |
| Grok ACP    | `session/new` / `session/load` 的 `mcpServers` stdio descriptor | invocation                                       |
| Antigravity | `~/.gemini/config/mcp_config.json` 的 `shift_context` 注册      | 持久注册；不落 token，子进程继承 invocation 环境 |

Grok 使用 `--no-leader` 专属 ACP 进程，每次新建或恢复 session 都注入当前 invocation 的
`SHIFT_*` 凭据；旧 `--plugin-dir` 与仓库内 Grok MCP 插件已删除。Antigravity 项目插件不是
在线路径；全局注册合并既有 server，若同名 server 不属于 SHIFT 则显式失败。

Grok ACP billing usage 只从 `acp.prompt_result` 映射为一条 `usage.update`：优先
`result.usage`（ACP PromptResponse 实验字段），否则 `result._meta.usage`（Grok 当前
wire）。不订阅 `_x.ai/session_notification`，避免与 prompt result 双计。标准
`sessionUpdate: usage_update` 只更新上下文占用 / 窗口容量，不写入 billing totals。

---

### 3.4.2 Skill 投递

| 步骤            | 入口                                                                                                                        | 落点                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 加载 / 索引     | **仅** `src/server/skills.js`（`skills/*/SKILL.md`）                                                                        | 进程内 cache                                             |
| 隔离 worktree   | `agents/skill-materialize.js` ← `skills.prepareSkillDelivery` ← `chat-routes` 在 `runWorkspace` 确定后、start invocation 前 | `{worktree}/.agents/skills/<name>/SKILL.md` 副本（copy） |
| MCP 按需        | `list_platform_skills` / `load_platform_skill`                                                                              | 同一 loader 的只读视图                                   |
| Prompt 全文注入 | `prepareSkillDelivery` 失败时由 `augmentPrompt` **fallback**；只注入当前 Duty Skill 与短 handoff Skill                      | 用户消息 / receive bundle                                |

**结论（skill）：**

- 权威源只有仓库 `skills/*/SKILL.md`。worktree `.agents/skills` 是派生投递，禁止回读覆盖权威，也禁止写入 `project_dir` 或用户级 CLI home。
- 物化公开入口只有 `materializePlatformSkills`；`ensureWorktree` 不挂钩。
- 隔离 worktree 且 copy 成功：主路径 = 原生发现 + MCP；prompt 的短 catalog 只列当前 Duty Skill 与 `cross-agent-handoff`，不注入 Skill 全文。
- 无 worktree、物化失败或 workspace 就是 `project_dir`：fallback 只全文注入同一份当前 Duty allowlist，请求不 500。
- 物化器只覆盖或清理带 `.shift-platform-skill` 所有权标记的副本；同名用户 Skill 会显式报错并保留原内容。
- Prompt 全文注入的删除条件：支持原生发现的运行时在 SHIFT 隔离 worktree cwd 下能稳定加载当前 Duty Skill 后，再关闭 fallback。本版本保留降级路径。
- Provider identity 只描述 CLI/runtime。Duty→Skill 的单一映射在 `agents/duty-routing.js`；固定 Provider 岗位、hop playbook 选择器和重复 review/merge Skill 已删除。

---

### 3.5 Project-bound recall

| 检索层                     | 权威作用域解析                                        | 查询入口                                    |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Product Memory             | 活跃 Project 守卫 + 当前 `thread_id`                  | `recall-service` → memory search            |
| Message / Invocation       | 活跃 Project 守卫 + 当前 `thread_id`                  | `recall-service` → recall repository        |
| Project document / passage | 当前 Thread → active Project → `project_key`          | `projectEvidence.search(projectKey, query)` |
| Vector                     | `thread:<threadId>`；project-doc 追加可信 Project key | `embeddingRuntime.search(query, scopeKeys)` |
| Project 文档重建           | Project 表中的 active canonical path                  | `reindexThreadProject`                      |

**结论（recall）— Project 隔离已落地（2026-08-10）：**

- `searchSession`、Agent recall、Memory 注入、Invocation evidence 读取均先解析可信 Thread 的
  活跃 Project；缺失或归档作用域返回空结果或明确 unavailable，不退化为全库查询。
- project-doc FTS 与 vector 只接收从 Thread 绑定推导出的 `project_key`，不接受调用方选择 Project。
- 归档 Project 保留全部投影，恢复后重新可见；正常 recall 和 reindex 均排除归档 Project。

---

### 3.6 Project-first UI

- `App` 从 Project 列表解析当前 UI 偏好；会话查询 key 固定包含 `projectKey`，切换 Project
  会重置当前会话选择。
- `ProjectRail` 统一承载打开已有目录、切换、可恢复归档与恢复；归档文案明确不删除本地目录
  或历史对话。
- 新建会话只提交当前 `projectKey`；前端不再调用全局 `GET /api/sessions`，也不再提交
  `projectDir`。
- Web 不再公开 Workspace / Diff 页面；worktree 仍是后端执行隔离与交付校验机制，聊天仅保留
  文件变更摘要，审计页占用原工作区顶级入口；
  `/api/project` 与会话创建后修改目录的 UI 已删除。
- Server 测试直接执行 `open Project → create Session(projectKey) → chat(sessionId)`；
  不再通过 fetch 包装器补 `projectKey`、隐式建 Session 或改写 `projectDir`。
- 真实 CLI live 场景位于 `scripts/live/`：
  - `issue-fix`：sandbox 是独立克隆的上游仓库 @ 实例 base commit，硬断言 F2P 红→绿。
  - `collab-slice`：同一实例仓库上跑 Codex → Grok `implementation_plan` 交接，经
    `GET /api/sessions/:id/collaboration` 断言 phase/planHash，不断言 PR。
    live 默认使用 `output/live/.../shift-home` 隔离 SQLite，不写入交互式 `SHIFT_HOME`；
    `--use-default-home` 才选择 UI 库。issue-fix 判定逻辑在 `scripts/live/lib/assertions.js`，
    collab-slice 在 `scripts/live/lib/collab-assert.js`；确定性测试为
    `tests/live/sandbox-assert.test.js`、`tests/live/collab-assert.test.js` 与
    `tests/live/harness.test.js`。
- 产品 Memory 对 Agent 只公开 `shift_context` MCP；其私有 HTTP bridge 使用
  `/api/callbacks/memory-write`，已删除 `/api/callbacks/memory-upsert` 兼容别名及 CLI/测试入口。
- Web 只公开根入口 `/`；已删除无人调用的 `/react` 兼容跳转及其旧测试。

---

### 3.7 协作交付证据

| 步骤                  | 权威入口                                              | 责任方 / 调用方                | 结果                                                                  |
| --------------------- | ----------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| 代码 review           | `processWorkflowEvidenceOutput`                       | 当前 `review` / `deliver` Duty | changes requested 直接形成事件；approve 继续交付核验                  |
| commit / PR / CI 取证 | `worktree/delivery-verifier.verify`                   | 当前交付 Duty 后由平台只读核对 | 返回真实 Git/GitHub evidence                                          |
| 交付契约校验          | `recordDeliveryEvidence` → `validateVerifiedDelivery` | collab task registry           | 校验并持久化 review、commit、分支、PR 与 CI gate                      |
| Agent 目标核验        | `submitFinalAcceptance`                               | 当前 `accept` Duty             | 绑定 goal、solution、plan、review 与 commit hash，不写完成态          |
| Human 最终决定        | `decideFinalAcceptance` ← session-routes              | 本地用户                       | 唯一写入 accepted/rejected/incomplete 与 `final_acceptance_decided`   |
| 任务/验收卡只读       | `projectCollaboration` ← session-routes               | UI / live harness              | `GET /api/sessions/:id/collaboration` 投影目标、Seat/Duty、阻塞与证据 |

`GET /api/sessions/:sessionId/collaboration` 是任务卡与本线程 enabled Seats 的唯一公开读入口：
无 task 仍返回 SQLite 席位条；有 task 从 `collaboration_tasks`、latest DutyBinding 和 Git worktree
投影目标、当前 Seat/Duty/Skill、枚举 blocker、审查模式、脏文件数、HEAD、PR、CI 与下一动作。
接口不返回 plan/review 全文，也不写库；权威仍是 SQLite 协作事实与 Git 工作区。

Agent 的结构化 `final_acceptance` 只是逐项核验证据，不能把任务推进到 `done`。用户通过
`POST /api/sessions/:sessionId/collaboration/acceptance` 作出最终决定；服务端固定记录可信
Human actor。请求 `accepted` 时仍会重新检查 goal、solution、plan、review、commit、PR 与 CI
绑定，证据不足则持久化为 `incomplete`。验收决定绑定当前 goal、plan 与 commit；任一上游事实
变化都会清除旧决定。旧数据只有 phase=`done` 而没有匹配的 Human 决定时，也不会投影为已验收。

承担 `deliver` Duty 的 Seat 负责 PR 描述。平台要求 PR title 为 10–100 个字符，PR body 固定包含
`## 意图`、`## 主链路影响`、`## 路径变化（公开入口 / 双写）`、
`## 测试（旧接口测试是否处理）`、`## 风险与回滚`；缺少任一章节都会拒绝交付证据。

---

### 3.8 Seat / Duty 在线路由

Migration 30 已新增 `thread_seats` 和 `invocation_duty_bindings`，并为 collaboration task/event
增加 ADR-007 的目标、状态、evidence profile、actor 和 duty 字段。旧 Thread 的历史 Agent
参与者会确定性回填为 enabled Seat；旧 invocation 不猜测 Duty，因此不回填 DutyBinding。

新 Session 暂由 composition root 将当前 catalog 确定性初始化为 enabled Seats；初始 chat 与 A2A
handoff 都通过 `thread-seat-repository` 解析目标。明确指定未启用 Seat 会显式失败。Worklist 继续保存
Provider ID 作为现有运行器键，同时相同下标的 cause 保存 `{ seatId, duty, skillName,
routingReason, enforcementLevel }`，因此没有新增第二套调度器。

`durableRecorder.startInvocation` 在原有 start 事务内写入且只写入一条 DutyBinding，并把 Seat/Duty
写入首个 `invocation-start` 事件。初始 Duty 为显式请求值，否则 worktree=`implement`、普通会话=
`discuss`；handoff Duty 来自 intent。当前 catalog 初始化是 Provider 可用性发现接入前的兼容步骤。

`role-contracts.js` 已删除；catalog、identity、handoff policy 与证据门禁不再保存固定岗位。
`plan` / `implement` / `fix` 的写权限等级由当前 Duty 与 Provider 的 `permissionCallbacks`
运行能力共同决定；实现门禁通过通用 `SHIFT_IMPLEMENTATION_GATE` / `SHIFT_APPROVED_PLAN_HASH`
传输批准状态，不形成新的调度入口。

Recovery drill 已把两张新权威表纳入快照，并检查 binding 与 invocation/Seat 的 Thread 因果。

---

## 4. 双路径 / 双语义清单

| ID  | 主题                      | 当前结论                                                          | 状态   |
| --- | ------------------------- | ----------------------------------------------------------------- | ------ |
| D1  | Invocation finish 多出口  | 收口为 `completeInvocation`；reconcile/force 独立                 | 已收口 |
| D2  | 规范状态 vs DB 状态       | ADR-002 规范态经 `resolveFinishDbState` 映射到 DB 状态            | 接受   |
| D3  | Handoff 双触发            | chat end 与 callback post 均触发同一 durable finalize             | 接受   |
| D4  | Handoff 幂等进程内        | Map 已删除；SQLite partial unique index 仲裁 accepted             | 已收口 |
| D5  | 事件 sink 回退            | 无 transcript 热路径双写                                          | 已收口 |
| D6  | Message 双用例入口        | 两类用例共用 messageType 契约和物理写入口                         | 已收口 |
| D7  | Memory 双语义             | collaboration event ≠ product Memory；禁止半接线                  | 已收口 |
| D8  | Collab 任务 vs Handoff    | 两者分别为 SQLite 权威事实，不互相借表表达                        | 已收口 |
| D9  | worktree 双地图           | session Map 与 manager 文件职责分离                               | 接受   |
| D10 | Skill 投递双通道          | 原生/MCP 为主；prompt 全文注入仅 fallback，见 §3.4.2              | 过渡   |
| D11 | Seat/Duty vs 固定岗位语义 | 固定岗位合同、prompt、gate 与旧测试已删除；职责仅来自 DutyBinding | 已收口 |

**已收敛（保护，勿回退）：**

- 在线业务真相源 = SQLite（ADR-001）；server/agents **不** require dual/legacy 读写。
- A2A 业务 finalize = 单一 `finalizeA2ARoutes`；handoff lifecycle 由 SQLite repository 仲裁。
- Message 物理 insert = 单一 `appendMessage`（热路径）。
- Invocation 调度终态 = 单一 `completeInvocation`。
- 产品记忆写 = `writeMemoryCandidate`；协作事件 = `memoryCapture`（无 memoryService）。

---

## 5. 热路径 vs 归档候选

### 5.1 在线热路径（`npm start` composition）

| 区域     | 代表模块                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server   | `index.js`, `project-routes.js`, `chat-routes.js`, `callback-routes.js`, `session-routes.js`, `*-transport`                                                                  |
| agents   | `catalog`, providers, `handoff*`, `a2a-finalize`, `callbacks`, `collab-task-registry`, `skill-materialize`, invoke-*                                                         |
| storage  | `server-storage`, `project-repository`, `durable-recorder`, `event-store`, `sqlite-session-service`, `message-*`, `memory-service`, `recall-service`, Seat/Duty repositories |
| session  | bootstrap, health, sealer；transcript 仅供 canonical audit sink 与离线/测试工具                                                                                              |
| worktree | manager, delivery-verifier                                                                                                                                                   |

在线 composition root 必须为 Chat 显式注入 `durableRecorder`、`eventStore` 和
`memoryCapture`；缺失时启动即失败，不再用 NOOP sink 静默绕过 SQLite 持久化。
Bootstrap 与 Active Memory Card 分别只接受结构化 `{ packet, inject }` 和
`{ rendered, items, stats }` 返回契约，不再兼容历史字符串返回值。
Callback token 只存在于当前进程的 active thread 上下文，必须携带有效 `expiresAt`；
缺失、非法或已过期的 token 统一在验证入口清除，不存在永久有效兼容形态。
Callback 的 recall 与 invocation evidence 读取只使用注入的 SQLite `recallService`，
不再接受 transcript 作为在线回退读源。
`createMemoryCapture` 只接受 EventStore；已删除 transcript 测试 sink、空转的
`replayThread` 以及 Chat 启动时的 replay 等待。Bootstrap 的 invocation digest 也必须显式
注入 SQLite-backed source，模块不再默认读取文件 transcript。Agent 的 product Memory
写入说明固定为 thread scope，不再引导已退役的 project Memory 写入。

### 5.2 离线 / 工具（应保持出热路径）

下列模块由 scripts/tests 使用；当前 `src/server` 与 `src/agents` 禁止依赖：

| 模块（均在 `src/storage/offline/`）                | 用途                         | 引用方              |
| -------------------------------------------------- | ---------------------------- | ------------------- |
| `runtime-home.js` / `legacy-runtime-paths.js`      | 旧安装 SQLite 搬迁           | migrate-home script |
| `clean-epoch.js`                                   | 新库 epoch                   | prepare script      |
| `recovery-drill.js` / `audit-storage.js`           | SQLite 恢复演练 / 完整性审计 | drill/audit scripts |
| `memory-stabilization.js` / `memory-write-eval.js` | 记忆离线审计与 eval          | scripts + tests     |

旧 sessions/invocations JSON、provider session-map 与 transcript 的导入、dual 对账、混合归档、
清理执行器及其 fixture 已退役。`runtime-home` 仅迁移现存 `data/runtime/shift.sqlite` 安装，
不导入旧业务文件格式。

**禁止**从 `src/server` / `src/agents` require `storage/offline/*`。

带分级相关性和业务 outcome 证据的 Memory 评估位于
`src/storage/offline/labeled-recall-eval.js`，仅由 `scripts/eval-recall-fts.js` 调用。它计算
严格 Recall@K、MRR、nDCG@K 和离线业务结果关联；结果不进入在线热路径，也不反写业务表。

在线观测只读入口为 `/api/storage/health`、`/api/storage/observability/metrics`，以及唯一的
Session-scoped `/api/sessions/:sessionId/traces*` 查询、详情和导出路径。指标直接查询 SQLite
source tables，不建立第二业务真相源；Memory 在线指标拆为 MCP search 可用率与 Memory 层命中、
实际 injection 可用率与覆盖率、MCP write 结果计数；严格 Recall、used 与 correct 在无标注或证据
时保持 `null`。旧 storage-level Trace detail 路由已删除。

`GET /api/memories/usage?sessionId=` 是 Memory 使用证据的只读聚合入口：从
`memory_searched` / `memory_injected` 事件 payload 的 `memoryIds` 派生每条 Memory 的
被检索 / 被注入计数，供审计页 Memory 卡片展示；不写库、不建立第二真相源。审计页 Trace
详情展示 Memory 检索 / 注入证据与工具执行汇总，逐条工具过程只在主会话展示。

`/api/storage/observability/metrics` 接受可选 `threadId` 并将 Thread scope 与时间窗一起下推到
Handoff、Memory telemetry 和 outcome evidence 的 SQLite 聚合；Audit Console 必须传当前 Thread，
而 system health 继续由 `/api/storage/health` 独立展示。Handoff 公开主指标为 eligible accepted
样本的 `completion`，诊断漏斗从 durable source rows 展示 attempted、accepted、enqueued、started
与 completed；旧的 scheduling / execution / endToEnd 三个重叠公开字段已退出。

Web 的独立“审计”页面通过上述只读接口呈现 durable Trace 航线、失败断点以及带分子、分母和
pending/unknown 分类的 Handoff 与 Memory 指标。Trace 详情以单条 waterfall 时间轴表达因果：每次
模型 invocation 一条 generation 行，Memory 检索 / 注入为其子行，durable Handoff 渲染为 generation
之间的连接行；逐条工具过程只在主会话展示，审计页仅保留工具执行汇总。Memory 卡片展示既有 row 的
来源 Invocation、Message、创建者与 evidence anchor，并从 `memory_events` 使用证据聚合展示被检索 /
被注入次数（只读派生，不回写）。
界面不自行聚合或缓存业务事实。右侧会话栏只保留 Agent 与用量，不再承载完整 Trace/Memory 工作台。

Memory 在线指标按 Agent 行为拆分为 MCP search、实际 injection 与 MCP write。`memory_searched`
只由经认证的 `searchForAgent` 完成后写入；通用 `searchSession` 不写 MCP 审计。`memory_injected`
只由 chat worklist 在目标 Invocation 已 durable started 且注入包已交付时写一次，
`retrieveForTurn` 仅返回结构结果。指标只接纳 migration 29 后带 Invocation、Agent、operation key
与 payload version 的事件；旧事件保留为 historical，不猜测回填。

严格 Recall@K 与 MRR/nDCG 作为最近一次离线评估独立展示，不继承在线 24 小时时间窗。

Session Trace 列表由 `execution-read-model.searchForThread` 执行状态、Agent、时间、错误与分页
筛选；`execution-read-model.export` 提供 `structural-metadata-v1` 脱敏 JSON 导出。两者复用
同一可信 Session scope，不建立前端历史索引或新的写入口。列表和详情中的轮次与请求预览由
`execution-read-model` 引用同 Thread 的权威 user Message 并限长生成；无法建立可信关联时返回
`request: null`，不补造摘要或第二套 Trace 数据。

Session 审计概览由 `execution-read-model.auditSummary` 直接聚合 SQLite Thread、Message、Trace、
Invocation、Handoff、规范 Tool event、Memory telemetry 与 active Memory；公开只读入口为
`/api/sessions/:sessionId/audit-summary`，由 Session route 合并既有 billing usage summary。用户轮次
固定为该 Thread 内 user Message 的 `COUNT(DISTINCT COALESCE(client_turn_id, id))`；累计执行时长
只求和已有 `ended_at` 的 Trace，最近状态明确标记为 latest Trace state，不伪造 Session 终态。

`observability-repository.metrics` 同时读取当前窗口与紧邻的等长前序窗口，按显式最小样本量和
下降阈值派生 `stable | regressed | unknown`；不持久化聚合结果。health alerts 携带确定性的
诊断标题和操作建议，Web 事故队列只读消费这些派生输出，不形成修复状态机。
Handoff 全局窗口与 outcome evidence 窗口分别由 `handoffs_created_at` 和
`evidence_imports_kind_created` 支撑；查询计划测试防止数据增长后退化为全表扫描。

`trace-span-projection.js` 从 Invocation/context window、规范 tool events、带 Invocation 坐标的
Memory telemetry 和 durable Handoff 即时派生 generation/tool/recall spans 与 Handoff links。
详情 API 与 UI 消费该投影；不存在 span 写表，缺失结束事件由 `span_missing_end` health 暴露。

`observability-evidence-repository.js` 是 labeled recall eval 与 Memory outcome judgment 的唯一导入
入口，HTTP bridge 为 `POST /api/storage/observability/evidence`。导入只保存结构指标、可信坐标、
evidence ref 与 source hash；metrics 从该证据读取严格 Recall、used/correct 与业务结果合格分母。

可选 `observability-exporter.js` 只从 health/metrics 读模型生成去标识化结构快照，默认关闭，支持
SHIFT webhook JSON 与 Sentry envelope 传输。它不是标准 OTLP exporter，不读取 Trace payload、
不写 SQLite，失败仅通过独立 exporter health 暴露，不影响 Trace、Invocation、Handoff 或业务成功率。

`memory_events.recordSafe` 同时维护 `telemetry_sink_health` 的 sink 尝试与失败计数，health
由这些计数、权威完整性检查和 outbox pending age 派生本地告警。保留入口
`POST /api/storage/observability/retention` 只清理过期 best-effort `memory_events`；权威执行
事实和 pending outbox 不进入该清理路径。

Trace 完整性 health 以 migration 24 的实际应用时间作为契约适用边界：更早且没有
`trace_id` 的 Invocation 仅作为 `historical` 诊断计数，不参与当前告警，也不会被补造 Trace。

## 6. 事件类型 → 单一写入口

| 事件                         | 写入口                                                   | 允许的触发器                                      |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| trace start / finish         | `durableRecorder.startTrace` / `completeTrace`           | 仅 chat request 生命周期                          |
| invocation start + Duty bind | `durableRecorder.startInvocation`                        | 仅 chat 调度器；同事务写 invocation/binding/event |
| invocation finish            | `durableRecorder.completeInvocation`                     | chat 调度器；孤儿用 force/reconcile               |
| handoff preview              | `createHandoffConfirmationGate`                          | finalize；仅运行时待决状态                        |
| handoff accept/enqueue       | `finalizeA2ARoutes` → `durableRecorder.acceptHandoff`    | 用户确认后；测试可显式禁用 gate                   |
| hop bind/complete            | `durableRecorder.startInvocation` / `completeInvocation` | chat 调度器                                       |
| message user/system/callback | `appendToSession` → `appendMessage`                      | routes / callbacks                                |
| message assistant-final      | `completeInvocation({ message })` → `appendMessage`      | chat 成功收尾 only                                |
| product memory               | `memoryService.writeMemoryCandidate`                     | `shift_context.memory_write` MCP 私有 HTTP bridge |
| collab hop 幂等              | `handoff-repository`（SQLite）                           | 仅 finalize accept                                |

---

## 7. 核查方法（可复现）

```text
# 终态 / 启动
grep finishInvocation|finishWithAssistantMessage|startInvocation  → src/

# Handoff
grep finalizeA2ARoutes|tryAcceptRoute|completeByTargetInvocation → src/

# Message
grep appendMessage|appendToSession → src/

# Memory
grep writeMemoryCandidate|captureHandoff|memories.create → src/

# 热路径不得重新引入已退役 legacy 工具名
grep audit-dual|legacy-cleanup|migrate-runtime  → src/server, src/agents
# 预期：无匹配
```

最后核对日期：2026-09-03。若代码改变上述映射，必须在同一 PR 中更新本文件；若不影响，
PR 应明确说明原因。
