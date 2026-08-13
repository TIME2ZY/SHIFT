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
  ├─ session-routes     → sqlite-session-service (Project-bound thread CRUD)
  ├─ chat-routes        → start/finish Trace + start/stream/finish invocation + finalize A2A
  ├─ callback-routes    → mid-run postMessage / MCP 私有 HTTP bridge / (A2A finalize)
  ├─ memory-routes      → 读为主（list/search 等）
  └─ storage-routes     → 审计/运维向

Web App (web/src/app/App.tsx)
  ├─ projects feature  → /api/projects（选择、打开、归档、恢复）
  ├─ sessions feature  → /api/projects/:projectKey/sessions + Project-bound create
  └─ workspace feature → /api/sessions/:sessionId/workspace（目录绑定只读）

持久化核心：
  durable-recorder  → trace_runs + invocations + events + (assistant-final 原子 finish)
  sqlite-session-service → threads + messages (appendToSession)
  message-persistence.appendMessage → messages 表 + recall 投影
  event-store → invocation_events + outbox(JSONL 审计)
  memory-service → memories 表（产品记忆）
  handoff-repository → durable accept / bind / complete / restart reconcile
  observability-repository → live Trace completeness + qualified Handoff/Memory metrics
  execution-read-model → Session-scoped Trace / Invocation / Handoff durable timeline
  memory-capture → 协作事件（handoff-captured 等），非产品记忆行
  recall-service → 从可信 Thread 解析活跃 Project，再查询 thread / project 分区投影
```

| 主链路步骤         | 主要代码                                                       |
| ------------------ | -------------------------------------------------------------- |
| 1 打开 Project     | `project-repository.openDirectory` ← project-routes            |
| 2 建 thread        | `sqlite-session-service.createSession({ projectKey })`         |
| 3 Trace start      | `durable.startTrace` ← chat-routes                             |
| 4 用户消息         | `appendToSession` ← chat-routes                                |
| 5 start invocation | `durable.startInvocation({ traceId })` ← chat-routes           |
| 6 SSE 流式         | chat-routes + child-stream / ACP；事件 `appendInvocationEvent` |
| 7 终态             | `completeInvocation` 后 `completeTrace`                        |
| 8 消息/事件 SQLite | appendMessage / event-store / finishWithAssistantMessage       |
| 9 恢复             | SQLite threads/messages/trace_runs/invocations                 |
| 10 handoff         | **见 §3.2**（finalize 已统一，触发与 hop 生命周期仍分叉）      |

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

| 步骤                | 意图上的权威写入口                                            | 实际调用方                                                                                               | 落库                                                              |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| start               | `durableRecorder.startInvocation`                             | **仅** `chat-routes`（含 retry 再 start）                                                                | `invocations` + `invocation-start` event                          |
| 流式事件            | `durableRecorder.appendInvocationEvent` / `eventStore.append` | chat-routes 流循环；callbacks 记 callback-post/outcome；a2a-finalize 记 route 事件                       | `invocation_events` + outbox                                      |
| **调度终态（B-1）** | **`durableRecorder.completeInvocation`**                      | **chat-routes 全部产品终态**（`reason`: assistant-final / aborted / empty-under-seal / empty-emergency） | 有 `message` → 原子 finish+assistant-final；无 `message` → 仅终态 |
| 底层（模块私有）    | `finishInvocation` / `finishWithAssistantMessage`             | 仅 `completeInvocation` 内部                                                                             | 同上                                                              |
| 孤儿收口            | `reconcileThreadActive` → `forceTerminalInvocation`           | chat-routes 请求结束 `finally`                                                                           | 强制 `failed`/`aborted`（非产品成功路径）                         |
| 写失败兜底          | `forceFailInvocation`                                         | durable-recorder 内部 / 调用约定                                                                         | 避免长期 `active`                                                 |

**结论（终态）— B-1 已落地（2026-08-07）：**

- 调度器面对的唯一写入口 = `completeInvocation({ invocationId, code, signal, reason, endPayload, message? })`。
- 底层 `finishInvocation` / `finishWithAssistantMessage` 仅为模块私有实现，公开 recorder 不再导出。
- 分支决策（何时带 message、何时 aborted）仍在 chat-routes；B-1 收口的是**写入口**，不是把业务 if 全部下沉（避免夹带行为变更）。
- Callback **仍不** finish invocation；孤儿 reconcile 仍走 force 终端 API。

---

### 3.2 Handoff / A2A 消费

| 步骤                   | 意图上的权威入口                                         | 实际                                                            | 持久性                                                    |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| 解析 fence             | `agents/handoff.js`                                      | finalize 内 `selectCanonicalHandoffMatch`                       | 无                                                        |
| 策略                   | `handoff-policy.js`                                      | finalize 内 `decidePolicy`                                      | 无                                                        |
| 幂等 accept            | `durableRecorder.acceptHandoff`                          | finalize 内                                                     | SQLite `handoffs`，唯一 accepted flight                   |
| 入队下一 Agent         | `worklist.push` → `markHandoffEnqueued`                  | finalize 内；确认失败撤销本次 push                              | 请求内存 worklist + SQLite `enqueued_at`                  |
| 捕获 handoff 协作事件  | `memoryCapture.captureHandoff`                           | finalize 内                                                     | event-store `handoff-captured`（**不是** product memory） |
| 触发 finalize          | `finalizeA2ARoutes`                                      | **双触发：** chat 回合结束 + callback `postMessage`             | —                                                         |
| 目标 hop bind/complete | `durableRecorder.startInvocation` / `completeInvocation` | chat-worklist 传 `handoffId`；recorder 与 invocation 同事务写入 | SQLite `handoffs`                                         |
| 协作 phase / plan gate | `collab-task-registry`                                   | chat 流前检查；callback 侧 plan/workflow evidence               | SQLite repository（若注入）+ 进程逻辑                     |
| 路由诊断事件           | `appendRouteEvent`                                       | EventStore → else durableRecorder.**无 transcript 双写**（B-2） | SQLite events                                             |

**结论（handoff）— durable 0B-2 已落地：**

- 解析→策略→accept→enqueue 仍统一在 `finalizeA2ARoutes`；`enqueued_at` 只在 worklist 实际追加后确认。
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
| 镜像末条                | `mirrorLastMessage`                                 | durable-recorder       | 沿用消息上的 type                    |
| 物理 insert             | **仅** `message-persistence.appendMessage`          | 热路径                 | + recall upsert                      |

**结论（message）— B-3 已落地（2026-08-07）：**

- 契约写在 `message-persistence.js` 头部；`MESSAGE_TYPES` 再导出。
- Callback **必须** `messageType: "assistant-callback"`，不得冒充 final。
- 守卫测试：`tests/storage/message-write-path.test.js` 禁止 server/agents/session 直接 `.messages.append`。
- 离线 `migrate-runtime` 仍可直写 repository（非热路径）。

---

### 3.4 Memory 写入

| 类型                             | 入口                                                                     | 落点                               | 调用方                                            |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------- |
| **产品记忆**（decision/fact 等） | `memoryService.writeMemoryCandidate` → `captureOnce` → `memories.create` | `memories` + embedding 入队        | `shift_context` MCP → callback-routes 私有 bridge |
| **通用 capture API**             | `memoryService.capture` / `captureOnce`                                  | 同上                               | 服务内部；migrate-runtime 离线                    |
| **Handoff 协作事件**             | `memoryCapture.captureHandoff`                                           | **仅** `handoff-captured` **事件** | a2a-finalize                                      |
| **Window seal 事件**             | `memoryCapture.captureWindowSeal`                                        | `window-sealed` 事件               | seal 路径（若接线）                               |
| Recall / FTS / embedding         | 派生                                                                     | recall 表 / 向量                   | 投影只读查询为主                                  |

**结论（memory）— B-4 已落地（2026-08-07）：**

- `createMemoryCapture` **拒绝** `memoryService` 参数（防半接线）。
- composition root 只传 `eventStore`；注释标明产品记忆走 `writeMemoryCandidate`。
- 模块头文档区分 collaboration event vs product memory 行。
- Agent 面向的 Memory / Recall 公开工具只有 `shift_context` MCP 的 `memory_write`、
  `memory_evidence_list`、`recall_search`；`callback-client` 不再提供 Memory 命令。
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
- Workspace 通过 `/api/sessions/:sessionId/workspace` 显示后端解析的只读 Project 绑定；
  `/api/project` 与会话创建后修改目录的 UI 已删除。
- live 场景与 Server 测试直接执行 `open Project → create Session(projectKey) → chat(sessionId)`；
  不再通过 fetch 包装器补 `projectKey`、隐式建 Session 或改写 `projectDir`。
- 产品 Memory 对 Agent 只公开 `shift_context` MCP；其私有 HTTP bridge 使用
  `/api/callbacks/memory-write`，已删除 `/api/callbacks/memory-upsert` 兼容别名及 CLI/测试入口。
- Web 只公开根入口 `/`；已删除无人调用的 `/react` 兼容跳转及其旧测试。

---

### 3.7 协作交付证据

| 步骤                  | 权威入口                                              | 责任方 / 调用方               | 结果                                                 |
| --------------------- | ----------------------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| 代码 review           | `processWorkflowEvidenceOutput`                       | OpenCode workflow evidence    | changes requested 直接形成事件；approve 继续交付核验 |
| commit / PR / CI 取证 | `worktree/delivery-verifier.verify`                   | OpenCode 提交后由平台只读核对 | 返回真实 Git/GitHub evidence                         |
| 交付契约校验          | `recordOpenCodeDelivery` → `validateVerifiedDelivery` | collab task registry          | 校验并持久化 review、commit、分支、PR 与 CI gate     |
| 最终目标验收          | `submitFinalAcceptance`                               | Codex workflow evidence       | 绑定 goal、solution、plan、review 与 commit hash     |

OpenCode 是 PR 描述的唯一交付责任人。平台要求 PR title 为 10–100 个字符，PR body 固定包含
`## 意图`、`## 主链路影响`、`## 路径变化（公开入口 / 双写）`、
`## 测试（旧接口测试是否处理）`、`## 风险与回滚`；缺少任一章节都会拒绝交付证据。

---

## 4. 双路径 / 双语义清单

| ID  | 主题                     | 当前结论                                               | 状态   |
| --- | ------------------------ | ------------------------------------------------------ | ------ |
| D1  | Invocation finish 多出口 | 收口为 `completeInvocation`；reconcile/force 独立      | 已收口 |
| D2  | 规范状态 vs DB 状态      | ADR-002 规范态经 `resolveFinishDbState` 映射到 DB 状态 | 接受   |
| D3  | Handoff 双触发           | chat end 与 callback post 均触发同一 durable finalize  | 接受   |
| D4  | Handoff 幂等进程内       | Map 已删除；SQLite partial unique index 仲裁 accepted  | 已收口 |
| D5  | 事件 sink 回退           | 无 transcript 热路径双写                               | 已收口 |
| D6  | Message 双用例入口       | 两类用例共用 messageType 契约和物理写入口              | 已收口 |
| D7  | Memory 双语义            | collaboration event ≠ product Memory；禁止半接线       | 已收口 |
| D8  | Collab 任务 vs Handoff   | 两者分别为 SQLite 权威事实，不互相借表表达             | 已收口 |
| D9  | worktree 双地图          | session Map 与 manager 文件职责分离                    | 接受   |

**已收敛（保护，勿回退）：**

- 在线业务真相源 = SQLite（ADR-001）；server/agents **不** require dual/legacy 读写。
- A2A 业务 finalize = 单一 `finalizeA2ARoutes`；handoff lifecycle 由 SQLite repository 仲裁。
- Message 物理 insert = 单一 `appendMessage`（热路径）。
- Invocation 调度终态 = 单一 `completeInvocation`。
- 产品记忆写 = `writeMemoryCandidate`；协作事件 = `memoryCapture`（无 memoryService）。

---

## 5. 热路径 vs 归档候选

### 5.1 在线热路径（`npm start` composition）

| 区域     | 代表模块                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| server   | `index.js`, `project-routes.js`, `chat-routes.js`, `callback-routes.js`, `session-routes.js`, `*-transport`                                                        |
| agents   | `catalog`, providers, `handoff*`, `a2a-finalize`, `callbacks`, `collab-task-registry`, invoke-*                                                                    |
| storage  | `server-storage`, `project-repository`, `durable-recorder`, `event-store`, `sqlite-session-service`, `message-*`, `memory-service`, `recall-service`, repositories |
| session  | bootstrap, health, sealer, transcript（若仍注入）                                                                                                                  |
| worktree | manager, delivery-verifier                                                                                                                                         |

### 5.2 离线 / 工具（应保持出热路径）

下列模块由 scripts/tests 使用；当前 `src/server` 与 `src/agents` 禁止依赖：

| 模块（均在 `src/storage/offline/`）                | 用途                  | 引用方                 |
| -------------------------------------------------- | --------------------- | ---------------------- |
| `audit-dual-storage.js`                            | 历史 dual 对比        | scripts + tests        |
| `legacy-session-reader.js`                         | 读旧 sessions         | offline dual audit     |
| `legacy-cleanup-*.js`                              | 清理清单/执行         | plan/execute scripts   |
| `migrate-runtime.js`                               | 文件→SQLite 迁移      | migrate script + tests |
| `mixed-transcript-retirement.js`                   | 混合 transcript 归档  | archive/plan scripts   |
| `clean-epoch.js`                                   | 新库 epoch            | prepare script + tests |
| `recovery-drill.js` / `audit-storage.js`           | 恢复演练 / 完整性审计 | drill/audit scripts    |
| `memory-stabilization.js` / `memory-write-eval.js` | 记忆离线审计与 eval   | scripts + tests        |

**禁止**从 `src/server` / `src/agents` require `storage/offline/*`。

带分级相关性和业务 outcome 证据的 Memory 评估位于
`src/storage/offline/labeled-recall-eval.js`，仅由 `scripts/eval-recall-fts.js` 调用。它计算
严格 Recall@K、MRR、nDCG@K 和离线业务结果关联；结果不进入在线热路径，也不反写业务表。

在线观测只读入口为 `/api/storage/health`、`/api/storage/observability/metrics`，以及唯一的
Session-scoped `/api/sessions/:sessionId/traces*` 查询、详情和导出路径。指标直接查询 SQLite
source tables，不建立第二业务真相源；Memory 仅展示 best-effort hit rate，严格 Recall、used
与 correct 在无标注或证据时保持 `null`。旧 storage-level Trace detail 路由已删除。

Web 的“追踪”面板通过上述只读接口呈现 durable Trace 航线、失败断点以及带分子、分母和
pending/unknown 分类的 Handoff 与 Memory 指标。界面不自行聚合或缓存业务事实；Memory
hit rate 与严格 Recall@K 明确分栏，后者在没有标注集时显示为不可用。

Session Trace 列表由 `execution-read-model.searchForThread` 执行状态、Agent、时间、错误与分页
筛选；`execution-read-model.export` 提供 `structural-metadata-v1` 脱敏 JSON 导出。两者复用
同一可信 Session scope，不建立前端历史索引或新的写入口。

`observability-repository.metrics` 同时读取当前窗口与紧邻的等长前序窗口，按显式最小样本量和
下降阈值派生 `stable | regressed | unknown`；不持久化聚合结果。health alerts 携带确定性的
诊断标题和操作建议，Web 事故队列只读消费这些派生输出，不形成修复状态机。

`trace-span-projection.js` 从 Invocation/context window、规范 tool events、带 Invocation 坐标的
Memory telemetry 和 durable Handoff 即时派生 generation/tool/recall spans 与 Handoff links。
详情 API 与 UI 消费该投影；不存在 span 写表，缺失结束事件由 `span_missing_end` health 暴露。

`observability-evidence-repository.js` 是 labeled recall eval 与 Memory outcome judgment 的唯一导入
入口，HTTP bridge 为 `POST /api/storage/observability/evidence`。导入只保存结构指标、可信坐标、
evidence ref 与 source hash；metrics 从该证据读取严格 Recall、used/correct 与业务结果合格分母。

可选 `observability-exporter.js` 只从 health/metrics 读模型生成去标识化结构快照，默认关闭，支持
OTLP HTTP JSON 与 Sentry envelope 传输。它不读取 Trace payload、不写 SQLite，失败仅通过独立
exporter health 暴露，不影响 Trace、Invocation、Handoff 或业务成功率。

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
| invocation start             | `durableRecorder.startInvocation`                        | 仅 chat 调度器                                    |
| invocation finish            | `durableRecorder.completeInvocation`                     | chat 调度器；孤儿用 force/reconcile               |
| handoff accept/enqueue       | `finalizeA2ARoutes` → `durableRecorder.acceptHandoff`    | chat end、callback post                           |
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

# 热路径是否引用 legacy
grep audit-dual|legacy-cleanup|migrate-runtime  → src/server, src/agents
# 预期：无匹配
```

最后核对日期：2026-08-12。若代码改变上述映射，必须在同一 PR 中更新本文件；若不影响，
PR 应明确说明原因。
