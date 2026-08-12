# Live scenarios（真实 CLI，不进 `npm test`）

用 **真实 Grok CLI** 在 **与日常相同的 runtime DB** 上自动打多轮对话，验证记忆注入、window seal 等管道在真对话里是否立得住。

|      | `npm test`      | Live                                  |
| ---- | --------------- | ------------------------------------- |
| CLI  | mock            | **真 grok**                           |
| DB   | 测试夹具 / 内存 | **默认 `data/runtime`**（与 UI 同库） |
| 入口 | `npm test`      | `npm run test:live:solo-grok`         |

## 前置

1. Node 20+
2. 本机 `grok` 在 PATH 上，且已 `XAI_API_KEY` 或 `grok login`
3. 已准备 clean epoch 库（与 `npm start` 相同），例如：

```bash
npm run prepare:storage:epoch -- --db data/runtime/shift.sqlite
```

4. **不要**指望 live 使用隔离库：写入的 session / memory **会留在真实 runtime**，可在浏览器里打开同一会话继续聊。

## 50K 上下文窗（seal）

Grok 模型 profile 为 500K；live 默认逻辑窗 **`SHIFT_TEST_CAPACITY=50000`**。

该 env 必须在 **server 进程** 内生效：

```powershell
# 终端 1
$env:SHIFT_TEST_CAPACITY = "50000"
npm start

# 终端 2 — attach（默认）
$env:SHIFT_UI_TOKEN = "<与页面/服务相同的 token>"
npm run test:live:solo-grok
```

若未设置 `SHIFT_UI_TOKEN`，可从浏览器加载的页面 meta / 或启动日志侧自行固定 token。  
建议在 `.env` 中设置固定 `SHIFT_UI_TOKEN=...`，start 与 live 共用。

### spawn 模式（同库、脚本自起服务）

```powershell
$env:SHIFT_TEST_CAPACITY = "50000"   # 也会被 --capacity 写入
npm run test:live:solo-grok -- --mode spawn
```

spawn **仍使用默认 runtime 路径**（不建 tmp DB），仅额外包装 spawn 以落盘完整 prompt。

## 命令

```bash
# 只检查环境 + 打印话术
npm run test:live:solo-grok -- --dry-run

# 默认 attach
npm run test:live:solo-grok -- --ui-token "$SHIFT_UI_TOKEN"

# 续跑已有会话
npm run test:live:solo-grok -- --session-id <id>

# 未 seal 则失败 / 无 product memory 则失败
npm run test:live:solo-grok -- --require-seal --strict-memory
```

## 场景：`solo-grok-auth`

固定 **用户** 话术（登录鉴权讨论 → 规格堆上下文 → 回顾），**Grok 回复完全真实**。

默认最多 12 轮填充 + 1 轮回顾；中途 `event: sealed` 则提前进入回顾。

## 产物

写入 `output/live/solo-grok-<timestamp>/`（`output/` 已 gitignore）：

- `report.md` / `report.json`
- `session-id.txt`
- `turns/`、`sse/`、`assistant/`
- `prompts/`（仅 spawn 模式）
- `snapshot-memories.json` 等

## 验收（严格）

主验收只认 **clean run**（单次进程、无 `--session-id` / `--start-from`）：

| 标志              | 含义                                                    |
| ----------------- | ------------------------------------------------------- |
| `cleanRunPassed`  | 连续跑通且硬断言全过 — **唯一主验收**                   |
| `resumeRunPassed` | 仅当 `--allow-resume` 时，续跑可 exit 0（恢复能力测试） |

硬断言要点：

- **L0** 禁止用续跑冒充 clean pass
- **L9** seal 触发轮必须有非空回答或 `seal-and-replayed`（禁止空 assistant）
- **L10 / L10b** 禁止空 assistant-final
- **L11** 重放不得重复持久化 user message
- **F-*** 期望事实（24h TTL、无 refresh、SQLite…），非「回答看起来很长」

确定性单测（进 `npm test`）：`tests/scenarios/live-assert.test.js`  
（fake 投影 / seal 边界表在 `context-budget.js`，不依赖真 Grok。）

## Exit code

| Code | 含义                                             |
| ---- | ------------------------------------------------ |
| 0    | 硬断言通过（resume 须带 `--allow-resume`）       |
| 1    | 硬断言失败、空 assistant、续跑未授权、或运行错误 |
| 2    | Preflight 失败                                   |
| 3    | 超时                                             |
| 4    | `--strict-memory` 下软断言失败                   |

## 费用与时间

真模型、多轮、可能 high reasoning：可能 **数十分钟** 并产生 API 费用。先用 `--dry-run` 确认话术。

---

## 多 Agent 串行协作（`test:live:multi-collab`）

讨论环 **22K**（Gemini↔Codex，不改代码）→ 实现环 **48K**（Grok↔OpenCode，**useWorktree=true**）→ 回顾。

```powershell
# 推荐 spawn：同进程内切换 SHIFT_TEST_CAPACITY
npm run test:live:multi-collab -- --mode spawn

# 只打印话术
npm run test:live:multi-collab -- --mode spawn --dry-run

# 覆盖 capacity
npm run test:live:multi-collab -- --mode spawn --discuss-capacity 22000 --implement-capacity 48000
```

| 幕        | capacity | worktree | Agent          |
| --------- | -------- | -------- | -------------- |
| discuss   | 22000    | off      | gemini, codex  |
| implement | 48000    | **on**   | grok, opencode |
| recall    | 48000    | off      | codex          |

整场 **不因首次 seal 结束**；每幕跑完脚本内全部用户轮。断言见 `lib/multi-assert.js`（四角出现、A2A、seal 轮非空答等）。

**要求：** 本机 PATH 上有对应 CLI（gemini/antigravity、codex、grok、opencode）。

## Trace / Observability 1D 门禁

```powershell
npm run test:live:observability -- --mode spawn
```

该场景使用真实 Grok→Codex Handoff，随后重启同一服务并重新读取 Session Trace。报告会核对
SSE invocation ID、durable Trace/Invocation/Handoff、terminal outcome 与 storage health，并写入
`output/live/observability-acceptance-*/`。只有 `cleanRunPassed=true` 才允许开始 Phase 2。
