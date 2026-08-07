# AGENTS.md — SHIFT 工程与写码标准

> 本文档是人和 AI 助手在本仓库改代码时的**强制约定**。  
> 与 ADR 冲突时：先改文档并达成一致，再改代码；禁止实现自行选择语义。  
> 权威决策见 `docs/decisions/`；记忆细节见 `docs/memory-data-contract.md`。

---

## 0. 项目一句话

SHIFT 是**本地多 Agent 协作控制台**：不提供模型，只编排本机已安装的 Agent CLI/ACP，用 SQLite 持久化会话与协作状态，在浏览器展示过程。

**产品要稳的是主链路，不是抽象层数量。**

---

## 1. 主链路（任何改动不得破坏）

按优先级，下列路径必须始终正确、可测、可解释：

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

**合入前自问：** 这次改动是在加固主链路，还是在主链路旁再开一条路？

---

## 2. 架构分层（允许依赖方向）

```text
web/                  UI only → HTTP/SSE API
src/server/           传输与路由组装（薄）
src/agents/           Provider 适配、handoff、协作策略、进程监督
src/session/          上下文窗口、seal、transcript 组装
src/storage/          SQLite 真相源、repository、派生索引
src/worktree/         Git worktree 与交付校验
src/shared/           无 IO 或极薄共享（契约、路径、env）
scripts/              离线工具、迁移、eval、drill（默认不进热路径）
tests/                回归；钉意图，不钉偶然实现细节
```

### 依赖规则

| 允许 | 禁止 |
|------|------|
| `server` → `agents` / `session` / `storage` / `worktree` / `shared` | `storage` → `server` / `web` |
| `agents` → `storage`（经显式接口）/ `shared` / `session`（有限） | `shared` → 业务层 |
| `web` → 仅 HTTP API | `web` 直接假设 SQLite schema 细节 |
| `scripts` 可依赖 `src/*` | 热路径 `require` 仅用于迁移/审计的 legacy 模块 |

路由文件（`*-routes.js`）负责：**鉴权、解析请求、调领域函数、写响应**。  
禁止在 routes 内堆完整业务状态机；超过边界就下沉到 `agents` / `session` / `storage`。

---

## 3. 存储与真相源（不可协商）

遵循 **ADR-001**：

1. **SQLite 是唯一在线业务真相源**（thread / message / invocation / window / memory / collab task 等）。
2. **Git 工作区是项目代码真相源**；SQLite 只存引用、hash、索引与运行绑定。
3. **JSONL 是审计/诊断**，不参与在线仲裁或业务恢复。
4. **Recall / FTS / embedding / digest 是派生读模型**，必须可从权威源重建；禁止反向覆盖权威数据。
5. **禁止恢复 `files` / `dual` 在线模式**。`audit-dual-storage`、legacy cleanup 仅离线脚本使用。

写路径原则：

- 一个业务事件（例如 invocation finish、handoff 消费、memory 写入）**只有一个权威写入口**。
- 需要幂等：在**写入口**做，而不是再加一条平行写路径然后两边对账。

---

## 4. 写码铁律（专门克制「越修越大」）

### 4.1 加法必须配减法

| 你做了 | 合入前必须 |
|--------|------------|
| 新 Service / Gate / Policy / Registry | 删除或收窄至少一条旧路径/旧分支 |
| 新状态枚举值 | 更新契约 + 迁移/映射表 + 删掉过时分支 |
| 新「兼容 fallback」 | 写明删除条件与截止日期；禁止无主兜底 |
| 新抽象层 | 证明少一层会坏；否则不抽 |

**只加测试、不删旧路径，不算完成重构。**

### 4.2 禁止第三条路

同一语义禁止长期并存两套实现，例如：

- chat 与 callback **双消费**同一 handoff 且逻辑分叉
- 文件与 SQLite **双写**业务实体
- 两套 recall 排序「都半开着」

过渡期允许 feature flag 或单次迁移 PR；**不得**把过渡期写成默认架构。

### 4.3 失败要显式

- 主链路失败：返回/记录明确错误，**禁止**静默降级到另一套语义还报成功。
- 半成功（有 SSE 正文、无 durable finish）视为 **bug**，不是可接受降级。
- 空 `catch` 仅用于清理/best-effort IO；业务路径必须记录原因。

### 4.4 文件与模块体量

| 软上限 | 处理 |
|--------|------|
| 单文件 > 500 行 | 下次改动应拆分或证明不可拆 |
| 单文件 > 1000 行 | **禁止**继续堆逻辑；先拆再改 |
| 新建 `*-service.js` | 先找是否已有 repository/函数可扩展 |

优先按**用例/入口**拆分（finish、handoff consume、stream attach），不要为名词再套一层空 Service。

### 4.5 命名

- 代码标识符、文件名、API 字段：**英文**。
- 用户可见文案、ADR、本文件：中文可。
- 名副其实：`repository` = 持久化；`service` = 跨表/跨模块用例；`gate` = 硬拒绝策略；`policy` = 可配置规则。
- 禁止 evitative 命名：`utils2`、`helper-new`、`final-final`、`legacy` 进热路径。

### 4.6 契约优先于散落魔法值

协作枚举、handoff intent、phase、报告字段：以 `src/shared/collab-contracts.js` 与相关 ADR 为准。  
改枚举名/形状：**先改契约与 ADR，再改实现与测试**。

---

## 5. 语言与目录惯例

### Backend（`src/`, `scripts/`, `tests/`）

- Node **≥ 20**，**CommonJS**（`require` / `module.exports`）。
- 工厂函数优先：`createX(options)`，便于测试注入。
- 侧效应集中在 composition root（`src/server/index.js`）与明确的 `scripts/*`。
- 格式：Prettier（见 `.prettierrc.json`）；Lint：ESLint flat config。

### Frontend（`web/`）

- TypeScript + React + Vite。
- 功能按 `web/src/features/*` 划分；跨功能 API 放 `shared/api`。
- 服务端状态用现有 React Query 模式；流式/运行态用 `runtime/*`。
- 改 UI 行为必须有对应单测或 e2e（与现有测试层级一致）。

### 测试

```bash
npm test              # Node 单测
npm run test:web      # 前端单测
npm run verify:pr     # PR 全量门禁
```

测试原则：

1. **钉意图**（状态机、幂等、真相源、API 契约），少钉内部私有函数布局。
2. 新 bug 先补失败测试再修（回归向）。
3. 禁止为了让测试通过而复制一套与生产分叉的逻辑。
4. Live / eval（`scripts/live`, `evals/`）不替代单元与契约测试。

---

## 6. AI 助手专用规则

对 Cursor / Codex / Claude / Grok 等一切代理**同样生效**：

1. **先读再写**：改模块前读调用方与测试；禁止盲写平行实现。
2. **最小 diff**：只改任务需要的文件；禁止顺手大重构（除非任务就是重构）。
3. **不做投机平台化**：未要求时不要加 embedding、新 phase、新 gate、新 metrics 管道。
4. **重构完成定义** = 行为保持或按需求变更 **且** 旧路径删除/归档 **且** 测试更新。
5. **禁止**用「兼容层」掩盖不确定行为；不确定就查代码或问用户。
6. **禁止**在 `src/` 热路径重新引入 legacy 文件存储读写。
7. 文档：任务未要求时不新增 markdown；本文件与 ADR 除外（架构/契约变更时必须更新）。
8. 提交说明写清：动机、主链路影响、删除了什么。

### 改动分级

| 级别 | 例子 | 要求 |
|------|------|------|
| S | 文案、纯展示、单测修正 | 直接改 |
| M | 单模块行为、一个 API 字段 | 单测 + 自述主链路无影响 |
| L | handoff / finish / memory 写路径 / schema | 契约核对 + 多测 + 考虑迁移 |
| XL | 存储边界、双路径合并、目录大挪 | 先书面计划（见 §7），用户确认后分 PR |

AI 不得在未确认时启动 XL。

---

## 7. 架构清理与重整（执行路线）

目标：**能力保留，路径变少，主链路变短，半截工程收敛。**  
不是重写，是**收口**。

### 阶段 A — 冻结与地图（0.5–1 天，无行为变更）

- [x] 画出写路径清单：`invocation finish`、`handoff consume`、`memory write`、`message persist` 的入口文件与函数。（2026-08-07）
- [x] 标记 **双路径 / 双语义**（同一事件两个入口或两套状态枚举）。（见 map §4 D1–D10）
- [x] 标记 **可归档**：仅迁移/审计用、热路径已不引用的模块。（见 map §5.2）
- [ ] 本文件 §1 主链路做一次手工或脚本冒烟（单 Agent 全流程）。（可选；未在 Phase A 强制执行）

交付：[`docs/architecture-map.md`](docs/architecture-map.md)（路径表 + 双路径列表 + 归档候选）。  
**本阶段禁止大重构。** ✅ 文档已交付。

### 阶段 B — 收口写路径 ✅（2026-08-07，B-1…B-4）

详见 [`docs/architecture-map.md`](docs/architecture-map.md)。

1. **Invocation 终态** ✅ — `durableRecorder.completeInvocation`  
2. **Handoff 消费** ✅ — `finalizeA2ARoutes` + hop wrappers；无 transcript 热路径双写；幂等进程内（D4）  
3. **Message 持久化** ✅ — `appendMessage` 唯一物理写；callback 显式 `assistant-callback`  
4. **Memory 写入** ✅ — 产品 `writeMemoryCandidate`；协作事件 `memoryCapture`（拒 `memoryService` 半接线）

下一阶段：**C 拆肥文件**（`chat-routes` / `recall-service`），零行为优先。

### 阶段 C — 拆肥文件（无行为变更优先）

优先顺序：

1. `src/server/chat-routes.js` → 按 attach-stream / send-message / seal / handoff-trigger 拆到同目录模块，routes 只组装。
2. `src/storage/recall-service.js` → query 规划 / FTS / hybrid merge / 截断策略分离。
3. `src/agents/handoff.js` + `a2a-finalize.js` → parse / route / finalize 边界清晰。

完成标准：单文件行数降到 §4.4 软上限以下；测试仍绿；**不**借拆分加入新行为。

### 阶段 D — 子系统收敛（能力保留，模块变少）

- **Memory**：保留「写、读、inject、metrics」清晰边界；合并仅被单处使用的微文件；eval 留在 `scripts/` / `evals/`。
- **Recall**：在线默认一条检索策略（FTS 或 hybrid 选其一为默认）；另一策略显式配置，不双默认。
- **Gates**：plan / outcome evidence 保留，但调用点集中；策略数据进 SQLite/契约，不进散落 if。
- **Legacy / dual**：确认零热路径引用后，移至 `scripts/archive/` 或 `archive/`，主 `src` 不再 `require`。

### 阶段 E — 前端对齐

- API 类型与后端契约一致；避免 UI 私自解释 phase/状态。
- 运行态（`session-run-*`）与服务端终态不一致时，以服务端为准并修复同步。

### 阶段 F — 固化

- [ ] 更新本文件中已完成的勾选与「禁止事项」。
- [ ] ADR 与实现不一致处，改 ADR 或改代码，消除「文档阶段 N、代码阶段 N-2」。
- [ ] `npm run verify:pr` 全绿。

---

## 8. PR 与验证清单

每个 PR 描述建议包含：

```text
## 意图
## 主链路影响（§1 哪几步）
## 删除/收窄了什么（路径、文件、分支）
## 测试
## 风险与回滚
```

本地最低验证：

```bash
npm run check
npm run lint
npm test
# 若动到 web：
npm run typecheck:web
npm run test:web
```

PR 合并前：`npm run verify:pr`。

---

## 9. 明确非目标（防范围蔓延）

除非任务明确要求，否则不要做：

- 新的在线存储模式或「智能双读」
- 新的 Agent Provider（先提需求，不顺手加）
- 把 SHIFT 做成远程多租户 SaaS
- 为了「干净」重写整个 `src/storage` 或整个前端
- 扩大协作 phase 数量（见 ADR-004，五阶段已冻结）

---

## 10. 相关文件速查

| 主题 | 位置 |
|------|------|
| Agent 目录 | `src/agents/catalog.js` |
| 协作契约 | `src/shared/collab-contracts.js` |
| 存储组装 | `src/storage/index.js` / `server-storage.js` |
| HTTP 入口 | `src/server/index.js` |
| 存储边界 ADR | `docs/decisions/001-storage-truth-boundary.md` |
| 可靠性契约 ADR | `docs/decisions/002-multi-agent-reliability-contracts.md` |
| 五阶段工作流 | `docs/decisions/004-five-phase-collaboration-workflow.md` |
| 记忆数据契约 | `docs/memory-data-contract.md` |

---

## 11. 修订

- 变更本标准中的铁律或主链路定义时，应在 PR 中单独说明。
- 架构清理阶段完成后，把 §7 对应项改为「已完成」并注明日期，避免清单腐烂。
