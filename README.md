# SHIFT · 交班台

本机已经装着 Codex、Gemini、Grok、OpenCode，可是同一件事还是要来回粘贴上下文，做没做完也只能听 Agent 自己说。SHIFT 不提供模型，只把这些本机 CLI 编进**同一条任务线程**：讨论、实现、审查、交付都留在会话里，刷新或重启后还能接上。

![SHIFT 控制台](assets/shift-console.png)

打开本机项目，选一个席位，说出目标。需要换人时 `@` 一下；需要改代码时打开隔离工作区。一个席位就能走完全程，多席位只在你点名或交接时换人，不会因为换了职责就随机换人。

## 它实际解决什么

- **上下文不断档。** 用户消息、Agent 输出、工具过程和交接关系写在同一条会话里，不是各开一个终端各聊各的。
- **完成有证据。** 方案、代码审查、commit、PR、CI 由平台对照 Git / GitHub 核对。Agent 说 done 不算完成。
- **主分支不被下手。** 改代码跑在会话自己的 Git worktree 里，聊天里能看到文件变更，不要的改动可以丢掉。
- **过程可回看。** 思考、工具、进度和失败断点进审计页，不是刷完就消失的终端日志。

任务卡只展示目标和证据，不是审批弹窗。你提出目标、选择席位、必要时停下；交接和验收由席位与证据门禁推进。

## 一次典型任务

1. 左侧打开项目，新建对话，右侧选一个已登录的席位。
2. 说出目标。当前席位按这一跳的职责工作；需要换人时写 `@席位` 并交代下一步。
3. 要改仓库时打开「隔离改代码」，实现发生在会话 worktree，不直接改你正在看的目录。
4. 审查通过后由交付席位提交 PR；平台核验真实 commit、PR 和 CI。
5. 对照最初目标验收。证据齐了才写入完成，缺了会明确标成未完成。

默认席位是本机的 Codex、Gemini、Grok、OpenCode。模型可以在本机改，SHIFT 不打包这些 CLI，也不管账号。

## 上手

```bash
git clone https://github.com/TIME2ZY/SHIFT.git
cd SHIFT
npm ci
npm run storage:init-home
npm start
```

浏览器打开 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。需要 Node.js 20.19+、Git，以及至少一个已登录的 Agent CLI。数据在 `~/.shift/data`，不进这个仓库。

从旧版本的仓库内数据库升级，用 `npm run storage:migrate-home`。开发时用 `npm run dev:web`。

环境变量见 [`.env.example`](.env.example)。工程约定、实现路径和设计决策见 [`AGENTS.md`](AGENTS.md)、[`docs/architecture-map.md`](docs/architecture-map.md)、[`docs/decisions/`](docs/decisions/)。
