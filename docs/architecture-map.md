# Architecture Map — Phase A（写路径与双路径清单）

> **状态：** Phase A 完成（2026-08-07）  
> **范围：** 只读测绘；**无行为变更**。  
> **依据：** `AGENTS.md` §1 主链路、§7 阶段 A。  
> **下一步：** 阶段 B — 按事件类型收口写路径（建议先 invocation 终态）。

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
| 正常完成 + assistant 正文 | `durableRecorder.finishWithAssistantMessage` | **仅** chat-routes 成功收尾分支 | **同一事务**：`invocations.finish` + `appendMessage(assistant-final)` + `invocation-end` |
| 中止 / 空输出压力 / 空 emergency | `durableRecorder.finishInvocation` | chat-routes **多处**直接调用 | 仅终态 + event，**不**写 assistant-final |
| 孤儿收口 | `durableRecorder.reconcileThreadActive` → `forceTerminalInvocation` | chat-routes 请求结束 `finally` 清理 | 强制 `failed`/`aborted` |
| 写失败兜底 | `forceFailInvocation` | durable-recorder 内部 / 调用约定 | 避免长期 `active` |

**结论（终态）：**

- **库层 API 已收敛**到 `durable-recorder`（好）。
- **业务调用点未收敛**：`chat-routes.js` 内至少 4 类 finish 分支 + reconcile；逻辑与「何时算成功有消息」缠在同一大函数里。
- Callback **不** finish invocation（合理：mid-run）；但 callback 会 `appendToSession` 写入 assistant 片段（见消息路径）。

**阶段 B-1 建议：** 抽出单一 `completeInvocation({ reason, ... })`（或等价模块），chat-routes 只传原因；禁止 routes 内并列 4 套 finish 参数拼装。

---

### 3.2 Handoff / A2A 消费

| 步骤 | 意图上的权威入口 | 实际 | 持久性 |
|------|------------------|------|--------|
| 解析 fence | `agents/handoff.js` | finalize 内 `selectCanonicalHandoffMatch` | 无 |
| 策略 | `handoff-policy.js` | finalize 内 `decidePolicy` | 无 |
| 幂等 accept | `handoff-route-registry.tryAcceptRoute` | finalize 内 | **进程内 Map**（重启丢失） |
| 入队下一 Agent | `worklist.push` | finalize 内 | **请求内存 worklist** |
| 捕获 handoff 记忆事件 | `memoryCapture.captureHandoff` | finalize 内 | event-store 事件 `handoff-captured`（**不是** `memories` 行） |
| 触发 finalize | `finalizeA2ARoutes` | **双触发：** chat 回合结束 + callback `postMessage` | — |
| 目标 invocation 绑定/完成 hop | `handoffRouteRegistry.bindTargetInvocation` / `completeByTargetInvocation` | **主要在 chat-routes** | 进程内 |
| 协作 phase / plan gate | `collab-task-registry` | chat 流前检查；callback 侧 plan submit / workflow evidence | SQLite repository（若注入）+ 进程逻辑 |

**结论（handoff）：**

- **解析→策略→accept→enqueue 已统一**在 `finalizeA2ARoutes`（chat 与 callback 共用）——阶段 B 应**保护**这条统一，不要再拆回两套业务。
- **仍双路径的部分：**
  1. **触发源双入口**（chat end vs callback）——可接受，但 pre/post 钩子不对称（callback 有 plan/workflow evidence；chat 有 hop complete 与 assistant 终态绑定）。
  2. **幂等注册表进程内** vs **协作任务可 SQLite**——重启后 hop 幂等与任务状态生命周期不一致。
  3. **事件双沉**（历史兼容）：`appendRouteEvent` 仍可走 `eventStore` **或** `transcript` + `durableRecorder.appendInvocationEvent` 回退（见 a2a-finalize 注释 “Legacy fallback”）。

**阶段 B-2 建议：** 保持单一 `finalizeA2ARoutes`；把 hop bind/complete 收进同一协作模块；幂等键目标进 SQLite（或明确「仅进程内」并写进 ADR）；删除 transcript 热路径回退。

---

### 3.3 Message 持久化

| 场景 | 入口函数 | 文件 | 备注 |
|------|----------|------|------|
| 用户消息 / 系统提示写入 | `appendToSession` → `appendMessage` | `sqlite-session-service.js` | chat-routes 发消息时 |
| 助手终态正文 | `finishWithAssistantMessage` → `appendMessage` | `durable-recorder.js` | 与 invocation finish 同事务（主路径） |
| Callback 中途 assistant | `appendToSession` | callbacks → sqlite-session-service | **不**走 finishWithAssistantMessage；`source: "callback"` |
| Handoff repair / skip 系统消息等 | `appendToSession`（finalize 内） | a2a-finalize.js | 多处 |
| 镜像 session 快照 | `mirrorThread` / `mirrorLastMessage` | durable-recorder | start/seal 等路径可能同步 thread 元数据 + 末条消息 |
| 底层唯一 insert | `appendMessage` | `message-persistence.js` | 含 recall upsert |

**结论（message）：**

- **物理写入**已基本统一到 `appendMessage`（好）。
- **用例入口有两条主河：**
  - `appendToSession`：任意 role、即时提交、自管 sequence
  - `finishWithAssistantMessage`：assistant-final + 终态原子
- 风险：同一逻辑「助手说了话」在 chat 终态与 callback 中途语义不同（是否终态、messageType、是否重复段落）。

**阶段 B-3 建议：** 文档化 messageType 契约；callback 片段与 final 的去重/折叠规则写死一处；禁止第三处直接 `storage.messages.*` 插入（grep 守卫）。

---

### 3.4 Memory 写入

| 类型 | 入口 | 落点 | 调用方 |
|------|------|------|--------|
| **产品记忆**（decision/fact 等） | `memoryService.writeMemoryCandidate` → `captureOnce` → `memories.create` | `memories` + embedding 入队 | **callback-routes**（agent memory_write） |
| **通用 capture API** | `memoryService.capture` / `captureOnce` | 同上 | 服务内部；migrate-runtime 离线 |
| **Handoff 捕获** | `memoryCapture.captureHandoff` | **仅** `handoff-captured` **事件** | a2a-finalize |
| **Window seal 捕获** | `memoryCapture.captureWindowSeal` | seal 相关事件 | session/seal 路径（若接线） |
| Recall / FTS / embedding | 派生 | recall 表 / 向量 | message/memory 写入后投影；`recall-service` 只读查询为主 |

**注意：** `createServer` 向 `createMemoryCapture({ memoryService, eventStore, ... })` 传入了 `memoryService`，但 **`memory-capture.js` 当前并不接收/使用 `memoryService`**——handoff「记忆」与产品记忆表是**两套语义**。命名易误导。

**阶段 B-4 建议：** 产品记忆只保留 `writeMemoryCandidate`（及受控 admin）；handoff 事件改名或文档标明「非 memories 行」；去掉无效 `memoryService` 传参或真正接线（二选一，禁止半接线）。

---

## 4. 双路径 / 双语义清单（阶段 B 靶标）

| ID | 主题 | 现象 | 严重度 | 建议阶段 |
|----|------|------|--------|----------|
| D1 | Invocation finish 多出口 | chat-routes 内 finishInvocation ×N + finishWithAssistantMessage + reconcile | **高** | B-1 |
| D2 | 规范状态 vs DB 状态 | ADR-002：`created/started/streaming/sealed`…；DB CHECK：`active/completed/failed/aborted` | 中 | B-1 文档+映射单点 |
| D3 | Handoff 双触发 + 不对称钩子 | chat end / callback post 都 finalize；前后 gate 不一致 | 中高 | B-2 |
| D4 | Handoff 幂等仅进程内 | `handoff-route-registry` Map；重启可双消费 | 中高 | B-2 |
| D5 | 事件 sink 兼容回退 | eventStore vs transcript/legacy append | 中 | B-2 |
| D6 | Message 双用例入口 | appendToSession vs finishWithAssistantMessage | 中 | B-3 |
| D7 | Memory 双语义 | 产品行 vs handoff 事件；capture 未接 memoryService | 中 | B-4 |
| D8 | Collab 任务耐久 vs hop 注册表 | tasks 可 SQLite；hop 进程内 | 中 | B-2 |
| D9 | 进程内 worktree 地图 | `sqlite-session-service` worktrees Map vs worktree manager 文件 | 低（已注释） | 维持文档化 |
| D10 | 巨型编排文件 | `chat-routes.js` ~1660 行承载调度+终态+A2A+seal | **高（可维护性）** | C（拆文件，不先改语义） |

**已收敛（保护，勿回退）：**

- 在线业务真相源 = SQLite（ADR-001）；server/agents **不** require dual/legacy 读写。
- A2A 业务 finalize = 单一 `finalizeA2ARoutes`。
- Message 物理 insert ≈ 单一 `appendMessage`。
- Invocation start/finish 库 API ≈ 单一 `durable-recorder`。

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

| 模块 | 用途 | 引用方 |
|------|------|--------|
| `audit-dual-storage.js` | 历史 dual 对比 | `scripts/audit-dual-storage.js` |
| `legacy-session-reader.js` | 读旧 sessions | dual audit 等 |
| `legacy-cleanup-*.js` | 清理清单/执行 | plan/execute-legacy-cleanup scripts |
| `migrate-runtime.js` | 文件→SQLite 迁移 | `scripts/migrate-runtime-to-sqlite.js` |
| `mixed-transcript-retirement.js` | 混合 transcript 归档 | archive/plan scripts |
| `clean-epoch.js` | 新库 epoch | prepare script + **部分测试** fixture |
| `recovery-drill.js` | 恢复演练 | `scripts/drill-sqlite-recovery.js` |
| `audit-storage.js` | SQLite 完整性审计 | audit script + recovery-drill |

`clean-epoch` / `audit-storage` 测试依赖可保留；**禁止**重新进入 chat/callback 热路径。

### 5.3 命名/体量告警（非立即删除）

| 项 | 说明 |
|----|------|
| `memory-*.js` 约 14 文件 | 阶段 D 合并「单调用微文件」，保留写/读/inject 边界 |
| `recall-service.js` ~1400 行 | 阶段 C 拆查询规划 |
| `chat-routes.js` ~1660 行 | 阶段 C 按用例拆模块 |
| `collab-task-registry.js` ~900 行 | 与 hop registry 边界在 B-2 理清 |

---

## 6. 事件类型 → 目标单一写入口（阶段 B 验收表）

收口完成后，期望收敛为：

| 事件 | 唯一写入口（目标） | 允许的触发器 |
|------|-------------------|--------------|
| invocation start | `durableRecorder.startInvocation` | 仅 chat 调度器 |
| invocation finish | `durableRecorder.completeInvocation`（新建外观，内部再分有/无 message） | 仅 chat 调度器 + 明确 orphan reconcile |
| handoff accept/enqueue | `finalizeA2ARoutes`（或改名后的单一 facade） | chat end、callback post |
| message user/system | `sessionService.appendMessage`（可保持 appendToSession） | routes |
| message assistant-final | finish 外观内 append | 禁止 callback 直接冒充 final |
| product memory | `memoryService.writeMemoryCandidate` | callback/tool 唯一 HTTP |
| collab hop 幂等 | 单一 registry（理想：SQLite） | 仅 finalize / bind / complete |

---

## 7. 阶段 B 推荐 PR 切片（仍不改产品能力面）

1. **B-1 Invocation 终态收口**  
   - 抽 `completeInvocation` / 集中 finish 参数。  
   - 消除 chat-routes 内重复拼装；reconcile 仍调用同一 force 终端 API。  
   - 回归：`tests/server/chat-seal-lifecycle.e2e.test.js`、invocation 相关、server.test 子集。

2. **B-2 Handoff 生命周期**  
   - bind/complete 与 finalize 同模块边界。  
   - 去掉热路径 transcript legacy fallback。  
   - 记录 D4：进程内幂等是否升级 SQLite（单独 ADR/PR）。

3. **B-3 Message 契约**  
   - messageType + callback 片段规则；grep 无第三 insert。

4. **B-4 Memory 语义澄清**  
   - 修 createMemoryCapture 无效参数；文档/命名区分事件捕获 vs 产品记忆。

5. **C 拆 `chat-routes`**（行为零变更 PR）  
   - 在 B-1 后做，避免一边收口一边大挪。

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
