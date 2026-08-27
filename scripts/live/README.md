# Live scenarios（真实 CLI，不进 `npm test`）

用**真实 Agent CLI** 在**独立 sandbox 真实开源仓库**上修复真实 GitHub issue，验证 SHIFT 主链路
（project 绑定 → chat → SSE → invocation 终态 → SQLite 持久化）在真实协作中立得住。

|        | `npm test`      | Live                                                                     |
| ------ | --------------- | ------------------------------------------------------------------------ |
| CLI    | mock            | **真 codex / grok**                                                      |
| 靶项目 | 测试夹具        | **真实仓库 @ base commit**（dayjs）                                      |
| DB     | 临时目录 / 内存 | **隔离 `output/live/.../shift-home`**（`--use-default-home` 才用 UI 库） |
| 入口   | `npm test`      | `npm run test:live:issue-fix`                                            |

## 场景：issue-fix（S1）

对每个实例：

1. **Sandbox 准备**：克隆上游仓库 → checkout 实例 base commit → 应用 F2P 测试补丁并提交 → 安装依赖
2. **红灯预检**：跑项目测试，要求恰好 F2P 测试失败、其余全绿（否则实例无效，exit 2）
3. **open Project → create Session**：sandbox 作为 `project_dir` 绑定进 SHIFT
4. **chat**：真实 issue 文本作为用户消息交给 Agent，Agent 在 sandbox 里修 bug
5. **硬断言**：
   - L6 chat outcome：agent-exit 0、assistant 非空、invocation 终态 `completed`
   - L7 durable trace / messages 持久化（user + assistant-final）
   - L8 diff 范围：sandbox 只允许改 `src/**`（碰测试文件即失败）
   - L9 F2P 全绿 + 无 P2P 回归

## 实例清单（SWE-bench 语义）

`scripts/live/instances/<id>/`：

- `instance.json` — repo、baseCommit、failToPass 测试名、allowPrefixes
- `issue.md` — 原始 issue 文本（用户消息）
- `test.patch` — 来自上游修复 PR 的测试补丁（仅测试文件）

已收录（均已在 Windows 本机验证红→绿）：

| 实例         | issue                                      | base      |
| ------------ | ------------------------------------------ | --------- |
| `dayjs-2505` | `.utcOffset(0, true)` clone 与原实例不一致 | `1547bff` |
| `dayjs-2377` | duration `toISOString()` 浮点尾数泄漏      | `5f3f878` |

## 前置

1. Node 20+、git
2. 目标 Agent CLI 在 PATH（默认 codex，可用 `--agent grok`）
3. 网络可达 GitHub（克隆仓库）；可用 `--source <本地克隆>` 离线复用
4. sandbox 依赖安装默认 `npm ci`；可用 `--node-modules <路径>` junction 复用缓存加速
5. 仅当使用 `--use-default-home` 时需要已初始化的交互式 runtime DB：`npm run storage:init-home`

## 命令

```powershell
# 只打印计划与 prompt，不调用任何 CLI
npm run test:live:issue-fix -- --dry-run

# 单实例（默认 codex）
npm run test:live:issue-fix -- --instance dayjs-2505

# 换 Agent / 离线仓库源 / 复用 node_modules
npm run test:live:issue-fix -- --instance dayjs-2377 --agent grok --source D:\cache\dayjs --node-modules D:\cache\dayjs\node_modules

# 全部实例
npm run test:live:issue-fix

# 显式写入交互式 SHIFT_HOME（与 npm start 同库）
npm run test:live:issue-fix -- --instance dayjs-2505 --use-default-home
```

## 产物

`output/live/issue-fix-<timestamp>/`（`output/` 已 gitignore）：

- `shift-home/` — 本轮隔离 runtime（`--use-default-home` 时不创建）
- `<instance>/report.md` / `report.json` — 判定与逐项断言
- `<instance>/target/` — sandbox 仓库本体（保留现场，可在浏览器里继续聊）
- `<instance>/jest-before.json` / `jest-after.json` — 修复前后逐测试结果
- `<instance>/chat-sse.txt`、`chat-summary.json`、`messages.json`
- `<instance>/agent.patch`、`changed-files.json`、`session-id.txt`

## 验收

主验收只认 **clean run**（单次进程、无续跑）。所有硬断言通过即 exit 0。

| Code | 含义                                                   |
| ---- | ------------------------------------------------------ |
| 0    | 全部实例通过                                           |
| 1    | 硬断言失败或运行错误                                   |
| 2    | Preflight 失败（CLI 缺失、未知实例、实例红灯预检不过） |
| 3    | chat 超时                                              |

确定性单测（进 `npm test`）：`tests/live/sandbox-assert.test.js`、`tests/live/harness.test.js`
（断言语义与 harness 隔离不依赖真 CLI。）

## 费用与时间

真模型 + 真仓库：单实例约 5–20 分钟并产生 API 费用。先用 `--dry-run` 确认 prompt。

## 后续场景（规划中，未实现）

- S2 多 Agent + worktree 交付（handoff 恰好消费一次、主 repo 干净）
- S3 seal + 重启恢复
- S4 观测门禁（durable trace 完整性发布 gate）
