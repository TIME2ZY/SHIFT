# Live scenarios（真实 CLI，不进 `npm test`）

当前入口是任务委托准备期的真实 Codex CLI smoke。它使用隔离的 SQLite 和任务目录，
调用真实 `/api/tasks` API，验证主 Agent 能生成可编辑合同、durable trace 正常终结，
并且只读准备期没有修改项目文件。

```powershell
npm run test:live:delegation
```

前置条件：Node 20+、Git、已安装并登录的 Codex CLI，以及本机代理
`http://127.0.0.1:7897`。代理预检失败会停止，禁止绕过代理直连。
该命令会调用真实模型并使用现有配额；单次 CLI 限时 90 秒。

产物保存在 `output/live/delegation-smoke-<timestamp>/`：

- `home/`：本轮独立 runtime，不写交互式 SHIFT_HOME。
- `result.json`：生成的合同、所选 Agent、trace 终态及目录未修改检查。

此 smoke 不提交执行、不创建远端 PR。完整软件团队的 discuss → plan → implement →
review → deliver → accept、handoff 一次消费与完成证据绑定，由
`tests/server/collaboration-chat.test.js` 的确定性集成测试覆盖；Git/GitHub 取证使用测试替身。
真实 PR/CI 全链路仍需使用实际可交付的远端项目验证。

旧 `run-issue-fix.js`、`run-collab-slice.js` 及 npm 入口已删除：它们依赖旧版直接发送消息
执行接口，与冻结后发布委托的产品流程冲突。`instances/` 和 `lib/` 中的离线实例、
F2P/交接断言仍作为可复用评测材料保留，由 `tests/live/` 覆盖，不构成在线执行入口。
