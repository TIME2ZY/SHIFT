# 第五阶段 B：SQLite 恢复验收

- 执行时间：2026-07-26 16:25（Asia/Shanghai）
- 分支：`codex/storage-truth-boundary`
- 权威库：`data/runtime/shift.sqlite`
- 恢复目录：`data/runtime/recovery-drill-20260726-b`
- 完整机器报告：`data/runtime/recovery-drill-20260726-b/recovery-report.json`
- 结论：通过

`data/runtime` 属于本机运行数据，不进入 Git。本文只保存不含消息正文的验收摘要；
完整报告和备份保留在上述独立恢复目录中。

## 验收结果

| 检查项 | 结果 |
| --- | --- |
| 在线 SQLite backup 到空目录 | 通过，备份 1,863,680 bytes |
| storage epoch | 一致，schema version 13，active clean epoch |
| 权威 source rows | 12 个表逐表行数和 SHA-256 内容指纹一致 |
| SQLite integrity / foreign key | `integrity_check=ok`，0 foreign-key errors |
| 业务因果关系 | 10 类跨表/序列检查均为 0 violations |
| SQLite storage audit | 0 errors，0 warnings |
| recall / FTS 重建 | 248 / 248，一致 |
| memory search / FTS 重建 | 4 / 4，一致 |
| thread digest 重建 | 2 / 2，一致 |
| SQLite-only 产品启动 | 随机端口启动成功，未占用 8787 |
| 产品 API | health、sessions、messages、memories/context 均通过 |
| legacy fallback | 未创建 sessions、invocations 或 session-map 文件 |

API/context 验证选择信息最完整的恢复会话，准确恢复：

- 6 条 message；
- 2 条 product memory；
- 2 条 handoff；
- 1 条 pending suggestion；
- 1 份派生 digest。

## 数据边界

本次演练只读取当前权威数据库，并在全新的恢复目录中创建 backup、restored database、
临时 API smoke 目录和 report。没有覆盖权威库，没有停止当前产品服务，没有读取 JSONL
恢复业务状态，也没有删除或迁移任何 legacy 数据。

## 可重复命令

```powershell
npm run drill:storage:recovery -- --dir <new-empty-directory> --json
```

命令会拒绝非空目标目录。恢复报告包含：

- source/restored 权威表行数和确定性内容指纹；
- epoch、integrity、foreign-key 和业务因果检查；
- 投影重建前后统计及 storage audit；
- 随机端口 SQLite-only 产品 API/context smoke；
- legacy artifact 检查。
