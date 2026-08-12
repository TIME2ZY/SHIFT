function createObservabilityEvidenceRepository(db) {
  const insertImport = db.prepare(`
    INSERT INTO observability_evidence_imports
      (id, kind, producer, evidence_ref, source_hash, created_at)
    VALUES (@id, @kind, @producer, @evidenceRef, @sourceHash, @createdAt)
    ON CONFLICT(source_hash) DO NOTHING
  `);
  const insertRecall = db.prepare(`
    INSERT INTO recall_eval_imports
      (import_id, dataset_id, dataset_version, cutoff_k, cases, relevant_judgments,
       recall_at_k, mrr, ndcg_at_k)
    VALUES (@importId, @datasetId, @datasetVersion, @cutoffK, @cases, @relevantJudgments,
      @recallAtK, @mrr, @ndcgAtK)
  `);
  const insertJudgment = db.prepare(`
    INSERT INTO memory_outcome_judgments
      (import_id, thread_id, invocation_id, memory_id, used, correct, business_outcome)
    VALUES (@importId, @threadId, @invocationId, @memoryId, @used, @correct, @businessOutcome)
  `);

  const importTransaction = db.transaction((raw) => {
    const input = normalizeImport(raw);
    const inserted = insertImport.run(input).changes > 0;
    if (!inserted) {
      const existing = db
        .prepare("SELECT id, kind FROM observability_evidence_imports WHERE source_hash = ?")
        .get(input.sourceHash);
      return { imported: false, duplicate: true, id: existing.id, kind: existing.kind };
    }
    if (input.kind === "labeled_recall_eval") insertRecall.run(input.payload);
    else {
      assertJudgmentCoordinates(db, input.payload);
      insertJudgment.run(input.payload);
    }
    return { imported: true, duplicate: false, id: input.id, kind: input.kind };
  });

  return {
    import(input) {
      return importTransaction(input);
    },
    latestRecallEval() {
      const row = db
        .prepare(
          `
          SELECT r.*, i.producer, i.evidence_ref, i.source_hash, i.created_at
          FROM recall_eval_imports r JOIN observability_evidence_imports i ON i.id = r.import_id
          ORDER BY i.created_at DESC, i.id DESC LIMIT 1
        `
        )
        .get();
      return row ? mapRecall(row) : null;
    },
    judgmentMetrics(window = null) {
      const where = window ? "WHERE i.created_at >= @from AND i.created_at < @to" : "";
      const row = db
        .prepare(
          `
        SELECT COUNT(*) AS total,
          SUM(CASE WHEN used = 1 THEN 1 ELSE 0 END) AS used_yes,
          SUM(CASE WHEN used IS NOT NULL THEN 1 ELSE 0 END) AS used_known,
          SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct_yes,
          SUM(CASE WHEN correct IS NOT NULL THEN 1 ELSE 0 END) AS correct_known,
          SUM(CASE WHEN business_outcome = 'success' THEN 1 ELSE 0 END) AS outcome_success,
          SUM(CASE WHEN business_outcome <> 'unknown' THEN 1 ELSE 0 END) AS outcome_known
        FROM memory_outcome_judgments j
        JOIN observability_evidence_imports i ON i.id = j.import_id
        ${where}
      `
        )
        .get(window || {});
      if (Number(row.total || 0) === 0) return null;
      return {
        usedRate: rate(row.used_yes, row.used_known, row.total - row.used_known),
        correctRate: rate(row.correct_yes, row.correct_known, row.total - row.correct_known),
        businessSuccessRate: rate(
          row.outcome_success,
          row.outcome_known,
          row.total - row.outcome_known
        ),
      };
    },
  };
}

function normalizeImport(raw = {}) {
  const kind = requiredEnum(raw.kind, ["labeled_recall_eval", "memory_outcome_judgment"], "kind");
  assertAllowedFields(raw, kind);
  const base = {
    id: requiredString(raw.id, "import id", 120),
    kind,
    producer: requiredString(raw.producer, "producer", 120),
    evidenceRef: requiredString(raw.evidenceRef, "evidence ref", 300),
    sourceHash: requiredHash(raw.sourceHash),
    createdAt: validDate(raw.createdAt || new Date().toISOString()),
  };
  return {
    ...base,
    payload:
      kind === "labeled_recall_eval" ? recallPayload(raw, base.id) : judgmentPayload(raw, base.id),
  };
}

function assertAllowedFields(raw, kind) {
  const common = ["id", "kind", "producer", "evidenceRef", "sourceHash", "createdAt"];
  const fields =
    kind === "labeled_recall_eval"
      ? [
          ...common,
          "datasetId",
          "datasetVersion",
          "cutoffK",
          "cases",
          "relevantJudgments",
          "recallAtK",
          "mrr",
          "ndcgAtK",
        ]
      : [...common, "threadId", "invocationId", "memoryId", "used", "correct", "businessOutcome"];
  const allowed = new Set(fields);
  const unsupported = Object.keys(raw).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) {
    throw new Error(`Evidence import contains unsupported field(s): ${unsupported.join(", ")}.`);
  }
}

function recallPayload(raw, importId) {
  return {
    importId,
    datasetId: requiredString(raw.datasetId, "dataset id", 120),
    datasetVersion: requiredString(raw.datasetVersion, "dataset version", 80),
    cutoffK: positiveInteger(raw.cutoffK, "cutoff k"),
    cases: positiveInteger(raw.cases, "cases"),
    relevantJudgments: positiveInteger(raw.relevantJudgments, "relevant judgments"),
    recallAtK: ratio(raw.recallAtK, "Recall@K"),
    mrr: ratio(raw.mrr, "MRR"),
    ndcgAtK: ratio(raw.ndcgAtK, "nDCG@K"),
  };
}

function judgmentPayload(raw, importId) {
  const used = nullableBoolean(raw.used, "used");
  const correct = nullableBoolean(raw.correct, "correct");
  if (correct != null && used !== 1) throw new Error("correct requires used=true.");
  return {
    importId,
    threadId: requiredString(raw.threadId, "thread id", 120),
    invocationId: requiredString(raw.invocationId, "invocation id", 160),
    memoryId: optionalString(raw.memoryId, 160),
    used,
    correct,
    businessOutcome: requiredEnum(
      raw.businessOutcome,
      ["success", "failure", "unknown"],
      "business outcome"
    ),
  };
}

function assertJudgmentCoordinates(db, input) {
  const invocation = db
    .prepare("SELECT thread_id FROM invocations WHERE id = ?")
    .get(input.invocationId);
  if (!invocation || invocation.thread_id !== input.threadId)
    throw new Error("Judgment Invocation is outside the Thread scope.");
  if (input.memoryId) {
    const memory = db
      .prepare("SELECT owner_thread_id FROM memory_entries WHERE id = ?")
      .get(input.memoryId);
    if (!memory || memory.owner_thread_id !== input.threadId)
      throw new Error("Judgment Memory is outside the Thread scope.");
  }
}

function mapRecall(row) {
  return {
    importId: row.import_id,
    datasetId: row.dataset_id,
    datasetVersion: row.dataset_version,
    cutoffK: row.cutoff_k,
    cases: row.cases,
    relevantJudgments: row.relevant_judgments,
    value: row.recall_at_k,
    mrr: row.mrr,
    ndcgAtK: row.ndcg_at_k,
    producer: row.producer,
    evidenceRef: row.evidence_ref,
    sourceHash: row.source_hash,
    createdAt: row.created_at,
  };
}

function rate(numerator, denominator, unknown) {
  return {
    value: denominator > 0 ? numerator / denominator : null,
    numerator: Number(numerator || 0),
    denominator: Number(denominator || 0),
    unknown: Number(unknown || 0),
  };
}

function requiredString(value, name, max) {
  const v = String(value || "").trim();
  if (!v || v.length > max) throw new Error(`${name} is invalid.`);
  return v;
}
function optionalString(value, max) {
  return value ? requiredString(value, "optional id", max) : null;
}
function requiredHash(value) {
  const v = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(v)) throw new Error("source hash must be SHA-256 hex.");
  return v;
}
function requiredEnum(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} is invalid.`);
  return value;
}
function positiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} is invalid.`);
  return n;
}
function ratio(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} is invalid.`);
  return n;
}
function nullableBoolean(value, name) {
  if (value == null) return null;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean or null.`);
  return value ? 1 : 0;
}
function validDate(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error("createdAt is invalid.");
  return d.toISOString();
}

module.exports = { createObservabilityEvidenceRepository };
