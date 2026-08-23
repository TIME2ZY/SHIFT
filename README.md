# SHIFT · 交班台

> 一个本地控制台，让 Codex、Gemini、Grok 与 OpenCode 围绕同一条任务线程讨论、实现、审查和交付——每一次交接都有据可查。

![Node.js 20.19+](https://img.shields.io/badge/Node.js-20.19%2B-3c873a?style=flat-square)
![Agents](https://img.shields.io/badge/Agents-4-5b55e7?style=flat-square)
![Storage](https://img.shields.io/badge/Storage-SQLite-2563eb?style=flat-square)
![Status](https://img.shields.io/badge/Status-Active%20development-c46a16?style=flat-square)

[快速开始](#快速开始) · [工作方式](#工作方式) · [核心能力](#核心能力) · [架构与数据边界](#架构与数据边界) · [开发与验证](#开发与验证)

![SHIFT 控制台](assets/shift-console.png)

## 项目定位

SHIFT 是一个**本地优先**的多 Agent 协作控制台。它不提供模型，也不替代各家 Agent CLI，而是把本机已经安装和登录的 Agent 接入一条可审计的工作流：

- 同一会话保留用户消息、Agent 输出、工具过程和交接关系，刷新或重启后可恢复；
- 通过 `@Agent` 指定下一位协作者，Agent 也可以把任务继续交接出去；
- 用 SQLite 持久化会话、调用、上下文窗口、Memory 和 Recall 索引——只有一个真相源；
- 需要改代码时创建会话级 Git worktree，改动隔离、可审查、可显式丢弃；
- 每个协作阶段都有平台侧证据门禁：不是"Agent 说做完了"，而是 Git、PR 和 CI 的实际状态说了算。

## 工作方式

```text
用户提出目标
    │
    ├─ 选择一个 Agent 直接处理
    │
    └─ 多 Agent 接力
         Codex ↔ Gemini 讨论、互证；Codex 收敛方案
                 ↓
          Grok 提交带 hash 的具体修改方案
                 ↓
          Codex 显式批准后，Grok 才能在 worktree 实现
                 ↓
          OpenCode review / 回修闭环，随后交付 commit 和 PR
                 ↓
          Codex 按用户最初目标与收敛方案最终验收
```

这不是固定流水线。你可以只使用一个 Agent，也可以在任何一轮通过 `@Codex`、`@Gemini`、`@Grok` 或 `@OpenCode` 指定下一位。

### 证据门禁

SHIFT 与"把几个 CLI 串起来"的区别在于：平台不信任 Agent 的自述，每个关键跃迁都要拿出证据。

| 门禁     | 谁触发       | 平台核对什么                                                   |
| -------- | ------------ | -------------------------------------------------------------- |
| 方案批准 | Grok → Codex | 新方案 hash 自动撤销旧批准；未批准时 Grok 只有只读工具权限     |
| 代码评审 | OpenCode     | 结构化 `code_review`，changes requested 直接回到 implement     |
| 交付核验 | OpenCode     | 独立读取 Git/GitHub 核对 clean worktree、真实 commit、PR 与 CI |
| 最终验收 | Codex        | 必须绑定用户目标、收敛方案、实现方案和实际 commit，逐项给证据  |

所有协作事实——Trace、Invocation、Handoff、Gate——都落在 SQLite，并通过内置审计控制台可视化：失败断点、Handoff 漏斗、Memory 命中率、每步的因果链路。

### Agent 团队

Agent 配置以 [`src/agents/catalog.js`](src/agents/catalog.js) 为准。

| Agent        | 默认模型                  | 运行方式        | 默认职责                                        |
| ------------ | ------------------------- | --------------- | ----------------------------------------------- |
| **Codex**    | `gpt-5.6-sol`             | Codex CLI       | 开始/末尾把关、参与讨论、收敛方案、最终目标验收 |
| **Gemini**   | `gemini-3.6-flash`        | Antigravity CLI | 正常讨论、提出选项和反例、与 Codex 交叉验证     |
| **Grok**     | `grok-4.6`                | Grok Build ACP  | 先给具体修改方案，获批后实现、测试并总结        |
| **OpenCode** | `deepseek-v4-flash` (max) | OpenCode CLI    | 代码 review；通过后规范 commit、push 和 PR      |

模型、容量和职责目前是固定配置。SHIFT 不打包这些 CLI，也不管理它们的账号；使用前需要在本机分别安装并完成认证。

## 核心能力

| 能力             | 当前实现                                                              |
| ---------------- | --------------------------------------------------------------------- |
| 多 Agent 调度    | 支持 Codex、Gemini、Grok、OpenCode，可手动选择或在消息中使用 `@Agent` |
| 五阶段协作流     | discuss → implement → review → deliver → done，每阶段有持久化证据门禁 |
| 流式过程         | Node 服务通过 SSE 推送文本、思考、工具调用、进度、文件变化与运行状态  |
| 结构化交接       | 解析并记录 Agent 之间的 handoff，保留来源、目标和因果关系，只消费一次 |
| 会话与调用历史   | SQLite 持久化 thread、message、invocation、event 和 provider session  |
| 上下文窗口       | 按 Agent、模型、工作区跟踪容量、用量、seal 和 generation rotation     |
| Memory 与 Recall | 项目/会话范围 Memory、FTS 检索、可选向量召回和证据来源                |
| 隔离改代码       | 按会话创建或复用 Git worktree；聊天内展示文件变更摘要                 |
| 审计控制台       | Trace 航线、失败断点、Handoff 漏斗、Memory 指标、脱敏导出             |
| 本地安全边界     | 默认仅监听 `127.0.0.1`，UI 和 Agent callback 使用独立令牌             |

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
npm run storage:init-home
```

`storage:init-home` 在 `SHIFT_HOME/data`（默认 `~/.shift/data`）下创建全新 SQLite epoch，不会覆盖已有数据。从旧版本仓库内数据升级使用 `npm run storage:migrate-home`。

### 启动

```bash
npm start
```

`npm start` 会先构建 React 前端，再启动 Node 服务。浏览器打开 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。

开发模式使用 Vite：

```bash
npm run dev:web
```

开发入口为 [http://127.0.0.1:5173/](http://127.0.0.1:5173/)。开发脚本会为 Node API 与 Vite 生成并共享临时 UI Token。

### 第一次对话

1. 在左侧项目栏打开一个本机项目目录；
2. 新建会话（自动绑定该项目）；
3. 选择一个 Agent，输入任务；
4. 需要改代码时打开"改代码"，让任务运行在会话 worktree；
5. 聊天中查看文件变更摘要，审计页查看完整 Trace 与交付证据。

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

| 变量                      | 用途                                      | 默认值     |
| ------------------------- | ----------------------------------------- | ---------- |
| `PORT`                    | Node 服务端口                             | `8787`     |
| `INVOKE_CLI_PROXY`        | 所有 CLI 子进程共用的 HTTP(S) 代理        | 空         |
| `GROK_PROXY`              | Grok 专用代理覆盖                         | 空         |
| `INVOKE_CODEX_HOME`       | 隔离 Codex CLI 状态目录                   | 空         |
| `SHIFT_PWSH_PATH`         | Windows Provider 使用的 PowerShell 7 路径 | 自动发现   |
| `SHIFT_HOME`              | 应用根目录，运行数据位于其 `data/` 子目录 | `~/.shift` |
| `SHIFT_AUDIT_TRANSCRIPT`  | 是否写 canonical audit archive            | `on`       |
| `SHIFT_EMBEDDING_ENABLED` | 是否启用向量召回                          | `false`    |

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

- 权威数据：`SHIFT_HOME/data/shift.sqlite`（默认 `~/.shift/data/`）；
- SQLite sidecar：`shift.sqlite-wal`、`shift.sqlite-shm`，属于同一数据库；
- Canonical audit：`SHIFT_HOME/data/audit-transcripts/<epoch-id>/`；
- 本地运行数据、构建产物和测试输出均已加入 `.gitignore`；
- Memory、Recall、上下文窗口和调用记录都随项目保存在本机；
- Git worktree 位于项目的独立工作目录，不会直接改写当前工作区。

### 安全边界

- 服务默认只监听 `127.0.0.1`；
- 浏览器 API 使用每进程 UI Token，并检查请求来源；
- Agent callback 使用调用级 Token，并绑定 thread / invocation；
- Agent 子进程沿用本机 CLI 登录状态和必要的代理配置；
- `.env`、运行数据、密钥和凭据不应提交到 Git。

设计与数据契约详见 [`docs/decisions/`](docs/decisions/)（ADR）与 [`docs/architecture-map.md`](docs/architecture-map.md)（当前实现地图）。

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

`npm run verify:pr` 会运行上述静态检查、后端测试、Web 测试、浏览器 E2E 和生产构建；本地与 GitHub PR 使用同一门禁。真实 Provider 的 live 验收场景已被移除，替代方案见 `docs/architecture-map.md`。

---

**SHIFT** — 让 Agent 不只回答问题，也能在可审计的本地工作流中完成交接。
