# Live scenarios（真实 CLI，不进 `npm test`）

用 **真实 Grok CLI** 在 **与日常相同的 runtime DB** 上自动打多轮对话，验证记忆注入、window seal 等管道在真对话里是否立得住。

| | `npm test` | Live |
|--|------------|------|
| CLI | mock | **真 grok** |
| DB | 测试夹具 / 内存 | **默认 `data/runtime`**（与 UI 同库） |
| 入口 | `npm test` | `npm run test:live:solo-grok` |

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

## Exit code

| Code | 含义 |
|------|------|
| 0 | 硬断言通过 |
| 1 | 硬断言失败或运行错误 |
| 2 | Preflight 失败 |
| 3 | 超时 |
| 4 | `--strict-memory` 下软断言失败 |

## 费用与时间

真模型、多轮、可能 high reasoning：可能 **数十分钟** 并产生 API 费用。先用 `--dry-run` 确认话术。
