# Offline / migration-only storage tools

These modules are **not** part of the online hot path (`npm start` composition).
They exist for migrate, audit, recovery drill, and legacy cleanup.

Do not `require` them from `src/server`, `src/agents`, or other runtime modules.
