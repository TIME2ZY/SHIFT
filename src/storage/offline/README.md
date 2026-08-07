# Offline / migration-only storage tools

These modules are **not** part of the online hot path (`npm start` composition).
They exist for migrate, audit, recovery drill, legacy cleanup, and offline evals.

Do not `require` them from `src/server`, `src/agents`, or other runtime modules.

| Module | Purpose |
|--------|---------|
| `audit-*`, `legacy-*`, `migrate-runtime`, `recovery-drill`, `mixed-transcript-*`, `clean-epoch` | Storage migration / cleanup / drills |
| `memory-stabilization`, `memory-write-eval` | Offline memory audit and write eval gates |
