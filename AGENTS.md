# AGENTS.md — SHIFT 工程与写码标准

> 人和 AI 在本仓库改代码时的**强制约定**。  
> 与 ADR 冲突时：先改文档并达成一致，再改代码。  
> 决策与数据契约：`docs/decisions/`、`docs/memory-data-contract.md`。

---

## 1. 项目是什么

SHIFT 是**本地多 Agent 协作控制台**：不提供模型，只编排本机已安装的 Agent CLI/ACP；用 SQLite 持久化会话与协作状态；在浏览器展示过程。

**要稳的是主链路，不是抽象层数量，也不是 diff 行数。**

### 主链路（任何改动不得破坏）

```text
1. 建 thread + 绑定 project_dir
2. 用户发消息 → 选中/解析 Agent
3. 启动 invocation（明确 started）
4. SSE 流式输出（text / tool / progress）
5. 终态闭环（completed | failed | aborted，禁止长期 active 无故悬挂）
6. 消息与事件写入 SQLite（权威源）
7. 刷新/重启后会话可恢复
8. 可选：@Agent handoff 只消费一次，且产生可追踪的目标 invocation
```

合入前自问：是在加固主链路，还是在旁路再开一条路？

### 目录与依赖

```text
web/                  UI → 仅 HTTP/SSE API
src/server/           传输与路由组装（薄）
src/agents/           Provider、handoff、协作策略、进程
src/session/          上下文窗口、seal
src/storage/          SQLite 真相源、repository、派生索引
src/storage/offline/  迁移/审计/eval（禁止热路径 require）
src/worktree/         Git worktree 与交付校验
src/shared/           薄共享（契约、路径、env）
scripts/              离线工具、live、eval
tests/                回归（钉意图）
```

| 允许 | 禁止 |
|------|------|
| `server` → agents / session / storage / worktree / shared | `storage` → server / web |
| `agents` → storage（显式接口）/ shared | `shared` → 业务层 |
| `web` → HTTP API only | `web` 直接假设 SQLite schema |
| `scripts` 可依赖 `src/*` | 热路径 require `storage/offline/*` 或 dual/legacy 在线模式 |

路由：鉴权、解析、调领域函数、写响应。状态机与业务写路径下沉到 agents / session / storage。

### 存储真相（ADR-001）

1. **SQLite** 是唯一在线业务真相源。  
2. **Git 工作区** 是项目代码真相源；SQLite 只存引用与运行绑定。  
3. **JSONL** 仅审计/诊断，不参与在线仲裁。  
4. **Recall / FTS / embedding / digest** 是可重建的派生读模型。  
5. **禁止** `files` / `dual` 在线模式。

**写路径：** 一个业务事件只有一个权威写入口；幂等做在写入口，不双写再对账。

当前要点（实现锚点，非任务清单）：

| 事件 | 权威入口 |
|------|----------|
| invocation 终态 | `durableRecorder.completeInvocation` |
| handoff 消费 | `finalizeA2ARoutes`（hop bind/complete 经 a2a-finalize wrappers） |
| message 物理写 | `message-persistence.appendMessage` |
| 产品 memory 写 | `memoryService.writeMemoryCandidate` |
| 协作事件（非产品行） | `memoryCapture` + EventStore |
| 在线 recall 默认 | FTS；`hybrid` 需 `SHIFT_RECALL_MODE` / `recallMode` |

前端消息类型与运行态映射：`web/src/shared/contracts/`。

---

## 2. 什么叫「做好了」

### 主标准

1. 主链路正确、终态闭环、失败显式。  
2. 同一业务事件的**公开写入口**为 1（或更少），不是「新 facade + 旧入口并存」。  
3. 双路径/双语义删除或降到非热路径（禁止无截止日期的 `@deprecated`）。  
4. 旧公开 API 的测试删除或并入新语义；禁止改名叠两套。  
5. 下次改同一语义的心智范围更小。

### 不是主标准

| 信号 | 可用 | 禁止 |
|------|------|------|
| diff 净增/净减行 | 粗看是否只加不删路径 | 用行数否决或刷行数 |
| 单文件行数 | 提示是否该按用例拆 | 用「行数下降」当成功 |
| 测试条数 | 意图是否钉住 | 叠用例掩盖双入口 |

**减法减的是路径与旧测，不是 KPI 行数。**  
收口可以净增行（契约、单一 facade、守卫测），只要旧公开入口不可达。

> 完成 = 行为对 **且** 旧公开路径已死 **且** 测试钉新单一语义 — **与 diff 正负无关。**

---

## 3. 写码铁律

### 3.1 加法配减法（路径）

| 做了 | 合入前必须 |
|------|------------|
| 新公开写入口 / facade | 旧入口删除或不再导出，调用方迁完 |
| 新 Service / Gate / Policy | 收窄至少一条旧路径 |
| 新枚举 | 更新契约 + ADR + 删过时分支 |
| 新兼容 fallback | 删除条件与截止日期 |
| 新抽象 | 证明少一层会坏 |
| 新/改测试 | 旧接口测删或并 |

不算完成：只加 facade、只加测不删路径、为 diff 好看删测或糊逻辑。  
算完成：单入口、去掉一条双写、测只钉新语义（即使行数净增）。

### 3.2 禁止第三条路

禁止长期：双消费同一 handoff、文件与 SQLite 双写业务实体、两套默认 recall、新旧 finish 同时导出。  
过渡期仅单次迁移 PR。私有 helper 可以；**公开面单一**。

### 3.3 失败显式

- 禁止静默换语义还报成功。  
- 半成功（有 SSE、无 durable finish）是 bug。  
- 空 `catch` 仅清理/best-effort IO。

### 3.4 体量（信号，不是成绩）

| 软上限 | 处理 |
|--------|------|
| 单文件 > 500 行 | 评估按用例拆 |
| 单文件 > 1000 行 | 未计划拆分时禁止堆新业务分支 |
| 新 `*-service` | 先找已有入口能否扩展 |

按**用例**拆，不为名词再套一层。

### 3.5 命名与契约

- 标识符/路径/API：**英文**；用户文案/本文件：中文可。  
- `repository` / `service` / `gate` / `policy` 名副其实。  
- 协作枚举与 phase：`src/shared/collab-contracts.js` + ADR；先改契约再改实现。

### 3.6 语言与测试

**Backend：** Node ≥ 20，CommonJS；工厂 `createX`；Prettier + ESLint。  
**Frontend：** TS + React + Vite；`features/*`；React Query + `runtime/*`。  
**测试：** 钉意图；换 API 必须删/并旧测；`npm test` / `npm run test:web` / `npm run verify:pr`。

---

## 4. AI 助手规则

1. 先读调用方与测试，禁止盲写平行实现。  
2. 最小 diff；未要求不做大重构。  
3. 不投机加 embedding / phase / gate / metrics 管道。  
4. 重构完成定义见 §2，不是净减行。  
5. 禁止用兼容层代替删除热路径旧入口。  
6. 禁止热路径恢复 legacy 文件存储读写。  
7. 未要求不新增 markdown（本文件与 ADR 除外）。  
8. 提交说明：动机、主链路影响、删/收窄了哪条路径。  
9. 合入前自检：旧入口是否不可达？旧测删/并了吗？是否用兼容层糊弄？

| 级别 | 例子 | 要求 |
|------|------|------|
| S | 文案、纯展示 | 直接改 |
| M | 单模块行为 | 单测 + 主链路无影响 |
| L | finish / handoff / memory / schema | 契约 + 路径收口 + 测 |
| XL | 存储边界、双路径合并、大挪目录 | 先书面计划，用户确认 |

AI 不得擅自做 XL。

---

## 5. PR 与验证

```text
## 意图
## 主链路影响
## 路径变化（公开入口 / 双写）
## 测试（旧接口测是否处理）
## 风险与回滚
```

Review 看路径与语义，不用 `+N/-M` 当通过条件。

```bash
npm run check && npm run lint && npm test
# 动 web 时：
npm run typecheck:web && npm run test:web
# 合并前：
npm run verify:pr
```

---

## 6. 非目标（未明确要求则不做）

- 新在线存储模式或「智能双读」  
- 顺手加 Agent Provider  
- 远程多租户 SaaS  
- 为干净而整仓重写  
- 扩大协作 phase（见 ADR-004）  
- 以减行数为目标的重构  

---

## 7. 速查

| 主题 | 位置 |
|------|------|
| Agent 目录 | `src/agents/catalog.js` |
| 协作契约 | `src/shared/collab-contracts.js` |
| 工作流门禁 facade | `src/agents/workflow-gates.js` |
| 存储组装 | `src/storage/index.js`、`server-storage.js` |
| HTTP 入口 | `src/server/index.js` |
| 离线工具 | `src/storage/offline/` |
| 前端消息/运行态契约 | `web/src/shared/contracts/` |
| 存储边界 | `docs/decisions/001-storage-truth-boundary.md` |
| 可靠性契约 | `docs/decisions/002-multi-agent-reliability-contracts.md` |
| 五阶段工作流 | `docs/decisions/004-five-phase-collaboration-workflow.md` |
| 记忆数据契约 | `docs/memory-data-contract.md` |

变更本文件中的主链路、真相源或验收尺子时，PR 中单独说明。
