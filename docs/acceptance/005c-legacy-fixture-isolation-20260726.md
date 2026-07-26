# 第五阶段 C：Legacy fixture 与测试隔离验收

- 执行日期：2026-07-26
- 分支：`codex/storage-truth-boundary`
- 结论：通过

## 验收范围

保留一套最小化、完全合成的 legacy runtime fixture：

```text
tests/fixtures/legacy-runtime/
├── sessions.json
├── invocations.json
├── transcripts/thread-1/invocations/inv-1.jsonl
└── session-maps/thread-1/sessions.json
```

fixture 覆盖切换前仍需要验证的四类格式：

- session/thread/message 文件；
- invocation registry；
- invocation JSONL transcript；
- provider resume session map。

内容只使用 `thread-1`、`inv-1`、`C:/sanitized/project` 等合成标识。自动测试会拒绝
用户目录、邮箱、私钥、API key、access token 和 password 形态的内容。

## 隔离不变量

- 可变 legacy 测试必须先把 fixture 复制到系统临时目录；
- 迁移兼容测试不得读取本机 `data/runtime`；
- 除纯路径契约测试外，测试源码不得引用真实 runtime 文件路径或默认 runtime 存储常量；
- 测试不得无隔离参数调用 `createServer()`；
- 产品运行时不读取 `tests/fixtures`。

`npm test` 在启动 Node test runner 前执行上述静态边界检查。违反边界时测试立即失败，
不会继续读取可能存在的本机历史数据。

## 数据处理

本阶段没有迁移、修改或删除任何真实 legacy 数据。fixture 只替代 CI 和本机兼容性验证
对真实历史样本的需求。真实数据是否永久删除仍属于下一阶段的独立、显式操作。
