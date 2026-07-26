# 第五阶段 E：在线兼容模式退役验收

日期：2026-07-26

## 结论

ADR-001 的最后一项工程收尾已完成。SHIFT 产品服务现在只有 SQLite 在线路径；
`files` 和 `dual` 不再是可运行的产品模式。SQLite 是 thread、message、invocation、
provider resume、memory 和 recall 的唯一业务真相源。

## 实现边界

- composition root 启动时拒绝非 `sqlite` 的 storage mode；
- session/message 正常 API 直接使用 SQLite session service；
- invocation event 只在 SQLite 事务内写入，canonical JSONL 仅由 outbox 异步归档；
- chat 不再读取或写入 session-map、legacy invocation registry、session JSON 或 legacy transcript；
- recall/list/detail 不再扫描或回退 transcript；
- durable recorder 对 SQLite 写入错误 fail closed；
- 旧 session read wrapper 和在线 `dual-write` 命名已删除；
- legacy migrate、dual divergence audit、cleanup tooling 和脱敏 fixture 继续作为离线能力保留。

## 数据边界

本变更不迁移、不修改也不删除运行数据。权威数据库仍为：

```text
data/runtime/shift.sqlite
```

`shift.sqlite-wal` / `shift.sqlite-shm` 是同一权威数据库的 sidecar。Canonical JSONL
archive 仅用于审计、导出和恢复后核对，不是业务恢复源。

## 验证

- `npm run check`：通过，269 个 JavaScript 文件语法检查无错误；
- `npm run lint`：通过，0 error / 0 warning；
- `npm test`：通过，118 个隔离测试文件，882/882 tests；
- `npm run audit:storage -- --full`：通过，0 findings / 0 errors / 0 warnings；
- `git diff --check`：通过。
