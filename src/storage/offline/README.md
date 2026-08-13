# Offline / migration-only storage tools

These modules are **not** part of the online hot path (`npm start` composition).
They exist for current SQLite audit, recovery drills, runtime-home migration, and offline evals.
Legacy file-format import, dual-storage comparison, mixed-transcript retirement, and legacy-data
cleanup executors were retired after the cutover evidence and real legacy data were removed.

Do not `require` them from `src/server`, `src/agents`, or other runtime modules.

| Module | Purpose |
|--------|---------|
| `audit-storage`, `recovery-drill`, `clean-epoch`, `runtime-home` | SQLite audit / recovery / installation migration |
| `memory-stabilization`, `memory-write-eval` | Offline memory audit and write eval gates |
