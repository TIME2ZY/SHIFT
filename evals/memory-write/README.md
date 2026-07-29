# Memory Write evaluation

`cases.jsonl` is the versioned gold set for the Agent + Memory Write Skill.

Each prediction must be one JSON object per line:

```json
{"id":"decision-storage-authority","shouldWrite":true,"kind":"decision","topic":"storage.authoritative","scope":"project","atomic":true}
```

Validate the gold set:

```powershell
npm run eval:memory-write -- --validate-cases
```

Score Agent predictions:

```powershell
npm run eval:memory-write -- --predictions path/to/predictions.jsonl
```

The default gate requires complete case coverage, write precision ≥ 90%, write
recall ≥ 70%, kind/scope accuracy ≥ 90%, topic consistency ≥ 80%, and atomicity
pass rate ≥ 95%.
