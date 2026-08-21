# SHIFT · 交班台

> 在一个本地控制台里组织 Codex、Gemini、Grok 与 OpenCode，让不同 Agent 围绕同一条任务线程讨论、实现、审查和交接。

![Node.js 20.19+](https://img.shields.io/badge/Node.js-20.19%2B-3c873a?style=flat-square)
![Agents](https://img.shields.io/badge/Agents-4-5b55e7?style=flat-square)
![Storage](https://img.shields.io/badge/Storage-SQLite-2563eb?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active%20development-c46a16?style=flat-square)

[快速开始](#快速开始) · [核心能力](#核心能力) · [架构与数据边界](#架构与数据边界) · [开发与验证](#开发与验证) · [能力状态](#能力状态)

## 项目定位

SHIFT 是一个本地优先的多 Agent 协作控制台，不提供模型，也不替代各家 Agent CLI。它负责把本机已经安装和登录的 Agent 接入统一工作流：

- 在同一会话中保留用户消息、Agent 输出、工具过程和交接关系；
- 通过 `@Agent` 指定协作者，并允许 Agent 将任务继续交给下一位；
- 用 SQLite 持久化会话、调用、上下文窗口、Memory 和 Recall 索引；
- 在需要修改代码时创建会话级 Git worktree，展示状态与 diff；
- 在浏览器中查看实时输出、上下文用量、记忆和工作区变化。

SHIFT 让原本分散在多个终端里的 Agent 共享任务上下文，把一次性的模型调用组织成可持续推进的协作过程。

## 核心能力

| 能力             | 当前实现                                                              |
| ---------------- | --------------------------------------------------------------------- |
| 多 Agent 调度    | 支持 Codex、Gemini、Grok、OpenCode，可手动选择或在消息中使用 `@Agent` |
| 流式过程         | Node 服务通过 SSE 推送文本、思考、工具调用、进度、文件变化与运行状态  |
| 结构化交接       | 解析并记录 Agent 之间的 handoff，保留来源、目标和因果关系             |
| 会话与调用历史   | SQLite 持久化 thread、message、invocation、event 和 provider session  |
| 上下文窗口       | 按 Agent、模型、工作区跟踪容量、用量、seal 和 generation rotation     |
| Memory 与 Recall | 支持项目/会话范围 Memory、FTS 检索、可选向量召回和证据来源            |
| 隔离改代码       | 按会话创建或复用 Git worktree，展示状态、diff，并支持显式丢弃         |
| 本地安全边界     | 默认仅监听 `127.0.0.1`，UI 和 Agent callback 使用独立令牌             |

## Agent 团队

Agent 配置以 [`src/agents/catalog.js`](src/agents/catalog.js) 为准。

| Agent        | 默认模型                  | 运行方式        | 默认职责                                        |
| ------------ | ------------------------- | --------------- | ----------------------------------------------- |
| **Codex**    | `gpt-5.6-sol`             | Codex CLI       | 开始/末尾把关、参与讨论、收敛方案、最终目标验收 |
| **Gemini**   | `gemini-3.6-flash`        | Antigravity CLI | 正常讨论、提出选项和反例、与 Codex 交叉验证     |
| **Grok**     | `grok-4.6`                | Grok Build ACP  | 先给具体修改方案，获批后实现、测试并总结        |
| **OpenCode** | `deepseek-v4-flash` (max) | OpenCode CLI    | 代码 review；通过后规范 commit、push 和 PR      |

模型、容量和职责目前是固定配置。SHIFT 不打包这些 CLI，也不管理它们的账号；使用前需要在本机分别安装并完成认证。

## 工作方式

```text
用户提出目标
    │
    ├─ 选择一个 Agent 直接处理
    │
    └─ 多 Agent 接力
         Codex ↔ Gemini 讨论、互证；Codex 收敛
                ↓
         Grok 只读检查并提交带 hash 的具体修改方案
                ↓
         Codex 显式批准同一方案后，Grok 才能在 worktree 实现并总结
                ↓
         OpenCode review / 回修闭环，随后交付 commit 和 PR
                ↓
         Codex 按用户最初目标与收敛方案最终验收
```

这不是固定流水线。你可以只使用一个 Agent，也可以在任何一轮通过 `@Codex`、`@Gemini`、`@Grok` 或 `@OpenCode` 指定下一位。

即使已经开启 worktree，Grok 也不会在第一轮直接修改：方案批准前 ACP 只允许
read/search/think/fetch，edit/delete/move/execute 会被平台拒绝。批准状态和 plan hash 保存于
SQLite，不会因服务重启丢失。

交付阶段同样采用证据门禁：OpenCode review 通过后亲自完成规范 commit、push、ready PR 和 CI，
平台再独立读取 Git/GitHub 验证实际状态。Codex 的最终验收必须绑定最初用户目标、Codex 收敛
方案、Grok 实现方案和实际 commit，并逐项给出验收证据；仅有“代码看起来合理”不能进入 done。

## 快速开始

### 环境要求

- Node.js `20.19+`、`22.12+` 或 `24+`；
- Git；
- 至少一个受支持且已登录的 Agent CLI；
- Windows 建议安装 PowerShell 7。

### 安装并初始化

```bash
git clone https://github.com/TIME2ZY/SHIFT.git
cd SHIFT
npm ci
```

首次使用时初始化本地数据库：

```bash
npm run prepare:storage:epoch -- --db data/runtime/shift.sqlite
```

该命令不会覆盖已有数据库，现有数据可以安全保留。

### 启动

```bash
npm start
```

`npm start` 会先构建 React 前端，再启动 Node 服务。浏览器打开：

[http://127.0.0.1:8787/](http://127.0.0.1:8787/)

开发模式使用 Vite：

```bash
npm run dev:web
```

开发入口为 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)。开发脚本会为 Node API 与 Vite 生成并共享临时 UI Token。

### 第一次对话

1. 新建会话并选择项目目录；
2. 选择一个 Agent；
3. 输入任务；
4. 需要改代码时打开“改代码”，让任务运行在会话 worktree；
5. 在工作区页面检查状态和 diff。

示例：

```text
分析这个项目最需要优先修复的三个问题。
@Gemini 提出三个实现方向，再交给 @Codex 收敛。
@Grok 在 worktree 中实现方案，完成后交给 @OpenCode 审查。
```

## 配置

所有配置都是可选环境变量，但 SQLite clean epoch 必须预先存在。复制示例文件：

```bash
# macOS / Linux / Git Bash
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

常用配置：

| 变量                         | 用途                                      | 默认值                           |
| ---------------------------- | ----------------------------------------- | -------------------------------- |
| `PORT`                       | Node 服务端口                             | `8787`                           |
| `INVOKE_CLI_PROXY`           | 所有 CLI 子进程共用的 HTTP(S) 代理        | 空                               |
| `GROK_PROXY`                 | Grok 专用代理覆盖                         | 空                               |
| `INVOKE_CODEX_HOME`          | 隔离 Codex CLI 状态目录                   | 空                               |
| `SHIFT_PWSH_PATH`            | Windows Provider 使用的 PowerShell 7 路径 | 自动发现                         |
| `SHIFT_MEMORY_DB`            | 权威 SQLite 数据库                        | `data/runtime/shift.sqlite`      |
| `SHIFT_AUDIT_TRANSCRIPT`     | 是否写 canonical audit archive            | `on`                             |
| `SHIFT_AUDIT_TRANSCRIPT_DIR` | canonical audit 根目录                    | `data/runtime/audit-transcripts` |
| `SHIFT_EMBEDDING_ENABLED`    | 是否启用向量召回                          | `false`                          |

完整配置及 Embedding 参数见 [`.env.example`](.env.example)。Shell 或 CI 中已经设置的环境变量优先于 `.env` / `.env.local`。

## 架构与数据边界

```text
React / Vite UI
       │ HTTP + SSE
       ▼
Node.js service
       ├── Agent adapters ── CLI / ACP ── 本机 Agent
       ├── SQLite ────────── 在线业务唯一真相源
       ├── audit JSONL ───── 审计、导出和核对，不是在线恢复源
       ├── Memory / Recall ─ FTS + 可选 sqlite-vec
       └── Git worktree ──── 可选的代码修改隔离层
```

### 本地数据

- 权威数据：`data/runtime/shift.sqlite`；
- SQLite sidecar：`shift.sqlite-wal`、`shift.sqlite-shm`，属于同一数据库；
- Canonical audit：`data/runtime/audit-transcripts/<epoch-id>/`；
- 本地运行数据、构建产物和测试输出均已加入 `.gitignore`；
- Memory、Recall、上下文窗口和调用记录都随项目保存在本机；
- Git worktree 位于项目的独立工作目录，不会直接改写当前工作区。

### 安全边界

- 服务默认只监听 `127.0.0.1`；
- 浏览器 API 使用每进程 UI Token，并检查请求来源；
- Agent callback 使用调用级 Token，并绑定 thread / invocation；
- Agent 子进程沿用本机 CLI 登录状态和必要的代理配置；
- `.env`、运行数据、密钥和凭据不应提交到 Git。

## 项目结构

```text
src/
  agents/       Agent catalog、Provider adapter、事件协议、handoff
  server/       HTTP/SSE 服务、路由、安全和静态资源
  session/      bootstrap、上下文预算、seal 与 transcript
  storage/      SQLite schema、repository、Memory、Recall、审计与恢复
  worktree/     Git worktree 生命周期
web/
  src/          React UI、运行态 store、API query/mutation
  e2e/          Playwright 浏览器测试
scripts/        开发、审计、迁移、评测和 live scenario
tests/          Node.js 单元、集成与存储测试
docs/           数据契约、ADR 和阶段验收记录
skills/         平台协作 Skill（`skills/<name>/SKILL.md`）；运行时物化到隔离 worktree 供 CLI 发现
```

## 开发与验证

### 常用命令

| 命令                    | 用途                         |
| ----------------------- | ---------------------------- |
| `npm run check`         | JavaScript 语法检查          |
| `npm run lint`          | ESLint                       |
| `npm run format:check`  | Prettier 格式检查            |
| `npm run typecheck:web` | React / TypeScript 类型检查  |
| `npm test`              | Node.js 单元与集成测试       |
| `npm run test:web`      | Vitest 前端测试              |
| `npm run test:web:e2e`  | Playwright 核心浏览器流程    |
| `npm run build:web`     | 构建 React 前端到 `dist/web` |

`npm run verify:pr` 会运行上述静态检查、后端测试、Web 测试、浏览器 E2E 和生产构建；本地与
GitHub PR 使用同一门禁。真实 Provider 的 `npm run test:live:observability` 保持手工发布验收，
避免普通 PR 依赖外部凭据。

## 能力状态

- [x] Trace / 审计平台（durable Trace、Handoff、指标与脱敏导出）
- [x] Phase 3 可运维化（浏览器验收、回归检测、本地告警、可选 exporter）

下一产品阶段在进入实现前单独立项；本清单只描述已经交付并有回归门禁的能力。

---

**SHIFT** — 让 Agent 不只回答问题，也能在可审计的本地工作流中完成交接。
