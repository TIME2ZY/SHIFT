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
  ├─ session-routes     → sqlite-session-service (thread CRUD / list)
  ├─ chat-routes        → start/stream/finish invocation + finalize A2A
  ├─ callback-routes    → mid-run postMessage / MCP 私有 HTTP bridge / (A2A finalize)
  ├─ memory-routes      → 读为主（list/search 等）
  └─ storage-routes     → 审计/运维向

持久化核心：
  durable-recorder  → invocations + events + (assistant-final 原子 finish)
  sqlite-session-service → threads + messages (appendToSession)
  message-persistence.appendMessage → messages 表 + recall 投影
  event-store → invocation_events + outbox(JSONL 审计)
  memory-service → memories 表（产品记忆）
  memory-capture → 协作事件（handoff-captured 等），非产品记忆行
```

| 主链路步骤         | 主要代码                                                       |
| ------------------ | -------------------------------------------------------------- |
| 1 建 thread        | `sqlite-session-service.createSession` ← session-routes        |
| 2 用户消息         | `appendToSession` ← chat-routes                                |
| 3 start invocation | `durable.startInvocation` ← chat-routes                        |
| 4 SSE 流式         | chat-routes + child-stream / ACP；事件 `appendInvocationEvent` |
| 5 终态             | **见 §3.1**（多出口）                                          |
| 6 消息/事件 SQLite | appendMessage / event-store / finishWithAssistantMessage       |
| 7 恢复             | SQLite threads/messages/invocations（session get）             |
| 8 handoff          | **见 §3.2**（finalize 已统一，触发与 hop 生命周期仍分叉）      |

---

## 3. 写路径清单（权威意图 vs 实际入口）

### 3.1 Invocation 生命周期（start / event / finish）

| 步骤                  | 意图上的权威写入口                                            | 实际调用方                                                                                               | 落库                                                              |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| start                 | `durableRecorder.startInvocation`                             | **仅** `chat-routes`（含 retry 再 start）                                                                | `invocations` + `invocation-start` event                          |
| 流式事件              | `durableRecorder.appendInvocationEvent` / `eventStore.append` | chat-routes 流循环；callbacks 记 callback-post/outcome；a2a-finalize 记 route 事件                       | `invocation_events` + outbox                                      |
| **调度终态（B-1）**   | **`durableRecorder.completeInvocation`**                      | **chat-routes 全部产品终态**（`reason`: assistant-final / aborted / empty-under-seal / empty-emergency） | 有 `message` → 原子 finish+assistant-final；无 `message` → 仅终态 |
| 底层（测试/外观内部） | `finishInvocation` / `finishWithAssistantMessage`             | 仅 `completeInvocation` 内部与存量单测                                                                   | 同上                                                              |
| 孤儿收口              | `reconcileThreadActive` → `forceTerminalInvocation`           | chat-routes 请求结束 `finally`                                                                           | 强制 `failed`/`aborted`（非产品成功路径）                         |
| 写失败兜底            | `forceFailInvocation`                                         | durable-recorder 内部 / 调用约定                                                                         | 避免长期 `active`                                                 |

**结论（终态）— B-1 已落地（2026-08-07）：**

- 调度器面对的唯一写入口 = `completeInvocation({ invocationId, code, signal, reason, endPayload, message? })`。
- 底层 `finishInvocation` / `finishWithAssistantMessage` 仍保留为实现与测试 API，**chat-routes 热路径不再直接调用**。
- 分支决策（何时带 message、何时 aborted）仍在 chat-routes；B-1 收口的是**写入口**，不是把业务 if 全部下沉（避免夹带行为变更）。
- Callback **仍不** finish invocation；孤儿 reconcile 仍走 force 终端 API。

---

### 3.2 Handoff / A2A 消费

| 步骤                   | 意图上的权威入口                        | 实际                                                                                 | 持久性                                                    |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 解析 fence             | `agents/handoff.js`                     | finalize 内 `selectCanonicalHandoffMatch`                                            | 无                                                        |
| 策略                   | `handoff-policy.js`                     | finalize 内 `decidePolicy`                                                           | 无                                                        |
| 幂等 accept            | `handoff-route-registry.tryAcceptRoute` | finalize 内                                                                          | **进程内 Map**（D4 明确不跨重启）                         |
| 入队下一 Agent         | `worklist.push`                         | finalize 内                                                                          | **请求内存 worklist**                                     |
| 捕获 handoff 协作事件  | `memoryCapture.captureHandoff`          | finalize 内                                                                          | event-store `handoff-captured`（**不是** product memory） |
| 触发 finalize          | `finalizeA2ARoutes`                     | **双触发：** chat 回合结束 + callback `postMessage`                                  | —                                                         |
| 目标 hop bind/complete | **`a2a-finalize` wrappers**（B-2）      | chat-routes 只调 `bindHandoffTargetInvocation` / `completeHandoffByTargetInvocation` | 进程内                                                    |
| 协作 phase / plan gate | `collab-task-registry`                  | chat 流前检查；callback 侧 plan/workflow evidence                                    | SQLite repository（若注入）+ 进程逻辑                     |
| 路由诊断事件           | `appendRouteEvent`                      | EventStore → else durableRecorder.**无 transcript 双写**（B-2）                      | SQLite events                                             |

**结论（handoff）— B-2 已落地（2026-08-07）：**

- 解析→策略→accept→enqueue 仍统一在 `finalizeA2ARoutes`。
- hop bind/complete 经 `a2a-finalize` 导出包装；chat 不再直接 require `handoff-route-registry`。
- 热路径去掉 transcript dual-write（callback 诊断事件同样）。
- **D4 仍开放：** 幂等仅进程内；升 SQLite 需单独 ADR/PR，禁止静默双写。

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

| 类型                             | 入口                                                                     | 落点                               | 调用方                                    |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------- |
| **产品记忆**（decision/fact 等） | `memoryService.writeMemoryCandidate` → `captureOnce` → `memories.create` | `memories` + embedding 入队        | `shift_context` MCP → callback-routes 私有 bridge |
| **通用 capture API**             | `memoryService.capture` / `captureOnce`                                  | 同上                               | 服务内部；migrate-runtime 离线            |
| **Handoff 协作事件**             | `memoryCapture.captureHandoff`                                           | **仅** `handoff-captured` **事件** | a2a-finalize                              |
| **Window seal 事件**             | `memoryCapture.captureWindowSeal`                                        | `window-sealed` 事件               | seal 路径（若接线）                       |
| Recall / FTS / embedding         | 派生                                                                     | recall 表 / 向量                   | 投影只读查询为主                          |

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

| Provider | 唯一接入方式 | 配置生命周期 |
| -------- | ------------ | ------------ |
| Codex | CLI `mcp_servers.shift_context.*` 参数 | invocation |
| OpenCode | `OPENCODE_CONFIG_CONTENT.mcp.shift_context` | invocation |
| Grok ACP | `session/new` / `session/load` 的 `mcpServers` stdio descriptor | invocation |
| Antigravity | `~/.gemini/config/mcp_config.json` 的 `shift_context` 注册 | 持久注册；不落 token，子进程继承 invocation 环境 |

Grok 使用 `--no-leader` 专属 ACP 进程，每次新建或恢复 session 都注入当前 invocation 的
`SHIFT_*` 凭据；旧 `--plugin-dir` 与仓库内 Grok MCP 插件已删除。Antigravity 项目插件不是
在线路径；全局注册合并既有 server，若同名 server 不属于 SHIFT 则显式失败。

---

### 3.5 协作交付证据

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

| ID  | 主题                      | 当前结论                                                  | 状态   |
| --- | ------------------------- | --------------------------------------------------------- | ------ |
| D1  | Invocation finish 多出口  | 收口为 `completeInvocation`；reconcile/force 独立         | 已收口 |
| D2  | 规范状态 vs DB 状态       | ADR-002 规范态经 `resolveFinishDbState` 映射到 DB 状态    | 接受   |
| D3  | Handoff 双触发            | chat end 与 callback post 均触发；hop API 经 a2a-finalize | 接受   |
| D4  | Handoff 幂等进程内        | 冻结为进程内；升 SQLite 必须另行修改 ADR                  | 待决策 |
| D5  | 事件 sink 回退            | 无 transcript 热路径双写                                  | 已收口 |
| D6  | Message 双用例入口        | 两类用例共用 messageType 契约和物理写入口                 | 已收口 |
| D7  | Memory 双语义             | collaboration event ≠ product Memory；禁止半接线          | 已收口 |
| D8  | Collab 任务 vs hop 注册表 | task 可持久化；hop 仍为进程内，与 D4 同一边界             | 接受   |
| D9  | worktree 双地图           | session Map 与 manager 文件职责分离                       | 接受   |

**已收敛（保护，勿回退）：**

- 在线业务真相源 = SQLite（ADR-001）；server/agents **不** require dual/legacy 读写。
- A2A 业务 finalize = 单一 `finalizeA2ARoutes`；hop bind/complete 经同一模块包装。
- Message 物理 insert = 单一 `appendMessage`（热路径）。
- Invocation 调度终态 = 单一 `completeInvocation`。
- 产品记忆写 = `writeMemoryCandidate`；协作事件 = `memoryCapture`（无 memoryService）。

---

## 5. 热路径 vs 归档候选

### 5.1 在线热路径（`npm start` composition）

| 区域     | 代表模块                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server   | `index.js`, `chat-routes.js`, `callback-routes.js`, `session-routes.js`, `*-transport`                                                                            |
| agents   | `catalog`, providers, `handoff*`, `a2a-finalize`, `callbacks`, `collab-task-registry`, invoke-*                                                                   |
| storage  | `server-storage`, `durable-recorder`, `event-store`, `sqlite-session-service`, `message-*`, `memory-service`, `recall-service`, repositories, `schema`/`database` |
| session  | bootstrap, health, sealer, transcript（若仍注入）                                                                                                                 |
| worktree | manager, delivery-verifier                                                                                                                                        |

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

## 6. 事件类型 → 单一写入口

| 事件                         | 写入口                                                              | 允许的触发器                        |
| ---------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| invocation start             | `durableRecorder.startInvocation`                                   | 仅 chat 调度器                      |
| invocation finish            | `durableRecorder.completeInvocation`                                | chat 调度器；孤儿用 force/reconcile |
| handoff accept/enqueue       | `finalizeA2ARoutes`                                                 | chat end、callback post             |
| hop bind/complete            | `bindHandoffTargetInvocation` / `completeHandoffByTargetInvocation` | chat 调度器                         |
| message user/system/callback | `appendToSession` → `appendMessage`                                 | routes / callbacks                  |
| message assistant-final      | `completeInvocation({ message })` → `appendMessage`                 | chat 成功收尾 only                  |
| product memory               | `memoryService.writeMemoryCandidate`                                | `shift_context.memory_write` MCP 私有 HTTP bridge |
| collab hop 幂等              | `handoff-route-registry`（进程内，D4）                              | 仅 finalize / bind / complete       |

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
