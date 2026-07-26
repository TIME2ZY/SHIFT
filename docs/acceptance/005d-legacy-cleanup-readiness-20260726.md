# 第五阶段 D：Legacy 清理就绪验收

- 执行日期：2026-07-26
- 权威 epoch：`epoch-a24f4c2186c3e79c7b5b74b87f38b7f2`
- 结论：清理前置条件通过，等待明确永久删除确认

## 混合 transcript 处理

旧 `data/runtime/transcripts` 包含 161 条 post-cutover canonical event，分布在 3 个
JSONL 文件。直接删除旧目录会损失这段审计归档，因此先执行了只追加、幂等的归档：

1. 从旧 transcript 收集稳定 `eventId`；
2. 逐项要求当前权威 SQLite `storage_outbox` 存在对应 row；
3. 以 SQLite row 为内容来源写入 active epoch 的受保护 audit archive；
4. 再次扫描并验证 161/161 eventId 已覆盖；
5. 重复执行结果为 `toArchive=0`、`archived=0`。

旧 transcript 没有在该步骤中删除或改写。

## 最终候选

最终 version 2 清理清单位于本机：

`data/runtime/legacy-cleanup-manifest-20260726.json`

| 目标 | 文件数 | bytes |
| --- | ---: | ---: |
| `sessions.json` | 1 | 383,593 |
| `invocations.json` | 1 | 5,842,789 |
| `transcripts/` | 357 | 4,358,345 |
| `session-maps/` | 16 | 11,573 |
| `memory.sqlite` | 1 | 7,962,624 |
| `memory.sqlite-wal` | 1 | 4,457,872 |
| `memory.sqlite-shm` | 1 | 32,768 |
| 合计 | 378 | 23,049,564 |

每个候选记录 SHA-256 内容指纹。执行时若路径、类型、文件数、字节数或指纹发生变化，
命令会拒绝删除并要求重新生成清单。

## 永久保护

下列内容不属于清理目标：

- `shift.sqlite`、`shift.sqlite-wal`、`shift.sqlite-shm`；
- `audit-transcripts/`；
- `recovery-drill-20260726/` 和 `recovery-drill-20260726-b/`；
- cleanup manifest、validation receipt、运行日志及 worktree 状态；
- `tests/fixtures/legacy-runtime/` 脱敏测试数据。

## 执行安全门

删除命令要求同时满足：

- active clean epoch 与 manifest 完全一致；
- 七个目标名称和路径处于固定 allowlist；
- 所有目标仍匹配 manifest 指纹；
- canonical archive coverage 仍为 161/161；
- 精确 confirmation token；
- 显式 `--apply`。

当前只执行了 `validate-only`，删除数为 0。永久删除后不可恢复，除非用户另行保留了
这些 legacy 文件的备份。
