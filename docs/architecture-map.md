# Architecture Map — Phase A（写路径与双路径清单）

> **状态：** Phase A–E 完成  
> **范围：** 写路径收口 + 拆肥 + 子系统收敛 + 前端契约/终态对齐。  
> **依据：** `AGENTS.md` §1 主链路、§7 阶段 A–E。  
> **下一步：** 阶段 F — 固化（清单/ADR/`verify:pr`）。

---

## 1. 目的

回答四个问题，供后续收口 PR 使用：

1. 四类业务事件现在从**哪些入口**写入？
2. 哪里存在**双路径 / 双语义**？
3. 哪些模块是**热路径**，哪些可**归档/迁出 `src` 热依赖**？
4. 阶段 B 应按什么顺序动刀？

---

## 2. 主链路与代码锚点（概览）

```text
HTTP createServer (src/server/index.js)
  ├─ session-routes     → sqlite-session-service (thread CRUD / list)
  ├─ chat-routes        → start/stream/finish invocation + finalize A2A
  ├─ callback-routes    → mid-run postMessage / memory_write / (A2A finalize)
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

| 主链路步骤 | 主要代码 |
|------------|----------|
| 1 建 thread | `sqlite-session-service.createSession` ← session-routes |
| 2 用户消息 | `appendToSession` ← chat-routes |
| 3 start invocation | `durable.startInvocation` ← chat-routes |
| 4 SSE 流式 | chat-routes + child-stream / ACP；事件 `appendInvocationEvent` |
| 5 终态 | **见 §3.1**（多出口） |
| 6 消息/事件 SQLite | appendMessage / event-store / finishWithAssistantMessage |
| 7 恢复 | SQLite threads/messages/invocations（session get） |
| 8 handoff | **见 §3.2**（finalize 已统一，触发与 hop 生命周期仍分叉） |

---

## 3. 写路径清单（权威意图 vs 实际入口）

### 3.1 Invocation 生命周期（start / event / finish）

| 步骤 | 意图上的权威写入口 | 实际调用方 | 落库 |
|------|-------------------|------------|------|
| start | `durableRecorder.startInvocation` | **仅** `chat-routes`（含 retry 再 start） | `invocations` + `invocation-start` event |
| 流式事件 | `durableRecorder.appendInvocationEvent` / `eventStore.append` | chat-routes 流循环；callbacks 记 callback-post/outcome；a2a-finalize 记 route 事件 | `invocation_events` + outbox |
| **调度终态（B-1）** | **`durableRecorder.completeInvocation`** | **chat-routes 全部产品终态**（`reason`: assistant-final / aborted / empty-under-seal / empty-emergency） | 有 `message` → 原子 finish+assistant-final；无 `message` → 仅终态 |
| 底层（测试/外观内部） | `finishInvocation` / `finishWithAssistantMessage` | 仅 `completeInvocation` 内部与存量单测 | 同上 |
| 孤儿收口 | `reconcileThreadActive` → `forceTerminalInvocation` | chat-routes 请求结束 `finally` | 强制 `failed`/`aborted`（非产品成功路径） |
| 写失败兜底 | `forceFailInvocation` | durable-recorder 内部 / 调用约定 | 避免长期 `active` |

**结论（终态）— B-1 已落地（2026-08-07）：**

- 调度器面对的唯一写入口 = `completeInvocation({ invocationId, code, signal, reason, endPayload, message? })`。
- 底层 `finishInvocation` / `finishWithAssistantMessage` 仍保留为实现与测试 API，**chat-routes 热路径不再直接调用**。
- 分支决策（何时带 message、何时 aborted）仍在 chat-routes；B-1 收口的是**写入口**，不是把业务 if 全部下沉（避免夹带行为变更）。
- Callback **仍不** finish invocation；孤儿 reconcile 仍走 force 终端 API。

---

### 3.2 Handoff / A2A 消费

| 步骤 | 意图上的权威入口 | 实际 | 持久性 |
|------|------------------|------|--------|
| 解析 fence | `agents/handoff.js` | finalize 内 `selectCanonicalHandoffMatch` | 无 |
| 策略 | `handoff-policy.js` | finalize 内 `decidePolicy` | 无 |
| 幂等 accept | `handoff-route-registry.tryAcceptRoute` | finalize 内 | **进程内 Map**（D4 明确不跨重启） |
| 入队下一 Agent | `worklist.push` | finalize 内 | **请求内存 worklist** |
| 捕获 handoff 协作事件 | `memoryCapture.captureHandoff` | finalize 内 | event-store `handoff-captured`（**不是** product memory） |
| 触发 finalize | `finalizeA2ARoutes` | **双触发：** chat 回合结束 + callback `postMessage` | — |
| 目标 hop bind/complete | **`a2a-finalize` wrappers**（B-2） | chat-routes 只调 `bindHandoffTargetInvocation` / `completeHandoffByTargetInvocation` | 进程内 |
| 协作 phase / plan gate | `collab-task-registry` | chat 流前检查；callback 侧 plan/workflow evidence | SQLite repository（若注入）+ 进程逻辑 |
| 路由诊断事件 | `appendRouteEvent` | EventStore → else durableRecorder.**无 transcript 双写**（B-2） | SQLite events |

**结论（handoff）— B-2 已落地（2026-08-07）：**

- 解析→策略→accept→enqueue 仍统一在 `finalizeA2ARoutes`。
- hop bind/complete 经 `a2a-finalize` 导出包装；chat 不再直接 require `handoff-route-registry`。
- 热路径去掉 transcript dual-write（callback 诊断事件同样）。
- **D4 仍开放：** 幂等仅进程内；升 SQLite 需单独 ADR/PR，禁止静默双写。

---

### 3.3 Message 持久化

| 场景 | 入口函数 | 文件 | messageType |
|------|----------|------|-------------|
| 用户 / 系统 / A2A 通知 | `appendToSession` → `appendMessage` | sqlite-session-service | `user` / `a2a-*` / `system-notice`… |
| 助手终态正文 | `completeInvocation({ message })` → `appendMessage` | durable-recorder | `assistant-final` |
| Callback 中途 assistant | `appendToSession` | callbacks | **`assistant-callback`（B-3 显式）** |
| 镜像末条 | `mirrorLastMessage` | durable-recorder | 沿用消息上的 type |
| 物理 insert | **仅** `message-persistence.appendMessage` | 热路径 | + recall upsert |

**结论（message）— B-3 已落地（2026-08-07）：**

- 契约写在 `message-persistence.js` 头部；`MESSAGE_TYPES` 再导出。
- Callback **必须** `messageType: "assistant-callback"`，不得冒充 final。
- 守卫测试：`tests/storage/message-write-path.test.js` 禁止 server/agents/session 直接 `.messages.append`。
- 离线 `migrate-runtime` 仍可直写 repository（非热路径）。

---

### 3.4 Memory 写入

| 类型 | 入口 | 落点 | 调用方 |
|------|------|------|--------|
| **产品记忆**（decision/fact 等） | `memoryService.writeMemoryCandidate` → `captureOnce` → `memories.create` | `memories` + embedding 入队 | **callback-routes**（agent memory_write） |
| **通用 capture API** | `memoryService.capture` / `captureOnce` | 同上 | 服务内部；migrate-runtime 离线 |
| **Handoff 协作事件** | `memoryCapture.captureHandoff` | **仅** `handoff-captured` **事件** | a2a-finalize |
| **Window seal 事件** | `memoryCapture.captureWindowSeal` | `window-sealed` 事件 | seal 路径（若接线） |
| Recall / FTS / embedding | 派生 | recall 表 / 向量 | 投影只读查询为主 |

**结论（memory）— B-4 已落地（2026-08-07）：**

- `createMemoryCapture` **拒绝** `memoryService` 参数（防半接线）。
- composition root 只传 `eventStore`；注释标明产品记忆走 `writeMemoryCandidate`。
- 模块头文档区分 collaboration event vs product memory 行。

---

## 4. 双路径 / 双语义清单（阶段 B 靶标）

| ID | 主题 | 现象 | 严重度 | 阶段 |
|----|------|------|--------|------|
| D1 | Invocation finish 多出口 | 收口为 `completeInvocation`；reconcile/force 独立 | **已降** | B-1 ✅ |
| D2 | 规范状态 vs DB 状态 | ADR-002 规范态 vs DB CHECK；映射仍在 `resolveFinishDbState` | 中 | 后续（非 B 阻断） |
| D3 | Handoff 双触发 | 触发双入口保留；hop API 经 a2a-finalize | **已降** | B-2 ✅ |
| D4 | Handoff 幂等进程内 | **冻结为进程内**；升 SQLite 另 ADR | 接受/待定 | B-2 文档 |
| D5 | 事件 sink 回退 | 无 transcript 热路径双写 | **已降** | B-2 ✅ |
| D6 | Message 双用例入口 | 两河 + messageType 契约 + 守卫测试 | **已降** | B-3 ✅ |
| D7 | Memory 双语义 | event capture ≠ product write；禁半接线 | **已降** | B-4 ✅ |
| D8 | Collab 任务 vs hop 注册表 | tasks 可 SQLite；hop 进程内（同 D4） | 中 | 随 D4 |
| D9 | worktree 双地图 | session Map vs manager 文件（已注释） | 低 | 维持 |
| D10 | 巨型编排文件 | ~~单文件 chat-routes~~ → routes + worklist + usage；recall-ranking 抽出；handoff-parse 抽出 | **已降** | C ✅ |

**已收敛（保护，勿回退）：**

- 在线业务真相源 = SQLite（ADR-001）；server/agents **不** require dual/legacy 读写。
- A2A 业务 finalize = 单一 `finalizeA2ARoutes`；hop bind/complete 经同一模块包装。
- Message 物理 insert = 单一 `appendMessage`（热路径）。
- Invocation 调度终态 = 单一 `completeInvocation`。
- 产品记忆写 = `writeMemoryCandidate`；协作事件 = `memoryCapture`（无 memoryService）。

---

## 5. 热路径 vs 归档候选

### 5.1 在线热路径（`npm start` composition）

| 区域 | 代表模块 |
|------|----------|
| server | `index.js`, `chat-routes.js`, `callback-routes.js`, `session-routes.js`, `*-transport` |
| agents | `catalog`, providers, `handoff*`, `a2a-finalize`, `callbacks`, `collab-task-registry`, invoke-* |
| storage | `server-storage`, `durable-recorder`, `event-store`, `sqlite-session-service`, `message-*`, `memory-service`, `recall-service`, repositories, `schema`/`database` |
| session | bootstrap, health, sealer, transcript（若仍注入） |
| worktree | manager, delivery-verifier |

### 5.2 离线 / 工具（应保持出热路径）

下列模块 **已被 scripts/tests 使用**；**当前 `src/server` 与 `src/agents` 无 require**（Phase A 核查）。适合阶段 D 迁到 `scripts/` 旁或 `src/storage/offline/` 并加 lint 禁依赖：

| 模块（均在 `src/storage/offline/`） | 用途 | 引用方 |
|------|------|--------|
| `audit-dual-storage.js` | 历史 dual 对比 | scripts + tests |
| `legacy-session-reader.js` | 读旧 sessions | offline dual audit |
| `legacy-cleanup-*.js` | 清理清单/执行 | plan/execute scripts |
| `migrate-runtime.js` | 文件→SQLite 迁移 | migrate script + tests |
| `mixed-transcript-retirement.js` | 混合 transcript 归档 | archive/plan scripts |
| `clean-epoch.js` | 新库 epoch | prepare script + tests |
| `recovery-drill.js` / `audit-storage.js` | 恢复演练 / 完整性审计 | drill/audit scripts |
| `memory-stabilization.js` / `memory-write-eval.js` | 记忆离线审计与 eval | scripts + tests |

**禁止**从 `src/server` / `src/agents` require `storage/offline/*`。

### 5.3 命名/体量告警（非立即删除）

| 项 | 说明 |
|----|------|
| `memory-*.js` 约 14 文件 | 阶段 D 合并「单调用微文件」，保留写/读/inject 边界 |
| `recall-service.js` ~1400 行 | 阶段 C 拆查询规划 |
| `chat-routes.js` ~1660 行 | 阶段 C 按用例拆模块 |
| `collab-task-registry.js` ~900 行 | 与 hop registry 边界在 B-2 理清 |

---

## 6. 事件类型 → 单一写入口（阶段 B 验收 — 已满足）

| 事件 | 写入口 | 允许的触发器 |
|------|--------|--------------|
| invocation start | `durableRecorder.startInvocation` | 仅 chat 调度器 |
| invocation finish | `durableRecorder.completeInvocation` | chat 调度器；孤儿用 force/reconcile |
| handoff accept/enqueue | `finalizeA2ARoutes` | chat end、callback post |
| hop bind/complete | `bindHandoffTargetInvocation` / `completeHandoffByTargetInvocation` | chat 调度器 |
| message user/system/callback | `appendToSession` → `appendMessage` | routes / callbacks |
| message assistant-final | `completeInvocation({ message })` → `appendMessage` | chat 成功收尾 only |
| product memory | `memoryService.writeMemoryCandidate` | callback/tool HTTP |
| collab hop 幂等 | `handoff-route-registry`（进程内，D4） | 仅 finalize / bind / complete |

---

## 7. 阶段 B PR 切片状态

1. **B-1 Invocation 终态** ✅  
2. **B-2 Handoff 生命周期** ✅（D4 文档冻结，不升 SQLite）  
3. **B-3 Message 契约** ✅  
4. **B-4 Memory 语义** ✅  
5. **阶段 C** 拆肥文件 ✅ — chat-worklist / recall-ranking / handoff-parse

---

## 8. Phase A 核查方法（可复现）

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
# （Phase A：无匹配）
```

测绘日期：2026-08-07。代码若漂移，先更新本文件再开 B 阶段 PR。

---

## 9. 非目标（Phase A 未做）

- 未改任何运行时代码行为  
- 未移动/删除 legacy 模块  
- 未拆分 chat-routes  
- 未将 handoff 幂等写入 SQLite  

以上均属后续阶段。
