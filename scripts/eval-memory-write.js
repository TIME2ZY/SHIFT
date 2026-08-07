#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  evaluateMemoryWriteGate,
  evaluateMemoryWritePredictions,
} = require("../src/storage/offline/memory-write-eval");

const DEFAULT_CASES = path.resolve(
  __dirname,
  "../evals/memory-write/cases.jsonl"
);

function parseArgs(argv) {
  const options = {
    cases: DEFAULT_CASES,
    predictions: null,
    json: false,
    validateCases: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cases") options.cases = path.resolve(argv[++index] || "");
    else if (arg === "--predictions") {
      options.predictions = path.resolve(argv[++index] || "");
    } else if (arg === "--min-precision") {
      options.writePrecision = Number(argv[++index]);
    } else if (arg === "--json") options.json = true;
    else if (arg === "--validate-cases") options.validateCases = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readJsonLines(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1}: ${error.message}`);
      }
    });
}

function validateCases(cases) {
  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item.id !== "string" || !item.id) {
      throw new Error("Every eval case requires a non-empty id.");
    }
    if (ids.has(item.id)) throw new Error(`Duplicate eval case id: ${item.id}`);
    ids.add(item.id);
    if (typeof item.input !== "string" || !item.input.trim()) {
      throw new Error(`Eval case ${item.id} requires input.`);
    }
    if (typeof item.expected?.shouldWrite !== "boolean") {
      throw new Error(`Eval case ${item.id} requires expected.shouldWrite.`);
    }
    if (item.expected.shouldWrite) {
      for (const field of ["kind", "scope", "topic"]) {
        if (typeof item.expected[field] !== "string" || !item.expected[field]) {
          throw new Error(`Eval case ${item.id} requires expected.${field}.`);
        }
      }
    }
  }
  return { cases: cases.length };
}

function printReport(report, gate) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(
    [
      `memory-write-eval passed=${gate.passed ? "yes" : "no"}`,
      `cases=${report.counts.cases}`,
      `coverage=${percent(report.metrics.coverage)}`,
      `precision=${percent(report.metrics.writePrecision)}`,
      `recall=${percent(report.metrics.writeRecall)}`,
      `kind=${percent(report.metrics.kindAccuracy)}`,
      `scope=${percent(report.metrics.scopeAccuracy)}`,
      `topic=${percent(report.metrics.topicConsistency)}`,
      `atomic=${percent(report.metrics.atomicityPassRate)}`,
    ].join(" ")
  );
  for (const failure of gate.failed) {
    console.log(
      `  gate ${failure.metric}: ${(failure.actual * 100).toFixed(1)}%` +
        ` < ${(failure.minimum * 100).toFixed(1)}%`
    );
  }
}

function printHelp() {
  console.log(`Usage: node scripts/eval-memory-write.js [options]

Options:
  --predictions <jsonl>  Agent predictions keyed by eval case id
  --cases <jsonl>        alternate case set
  --min-precision <n>    override the default 0.90 precision gate
  --validate-cases       validate the gold set without scoring predictions
  --json                 print the full report
  -h, --help             show help
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const cases = readJsonLines(options.cases);
  const validation = validateCases(cases);
  if (options.validateCases) {
    console.log(`memory-write-eval cases=ok count=${validation.cases}`);
    return;
  }
  if (!options.predictions) {
    throw new Error("--predictions is required unless --validate-cases is used.");
  }
  const predictions = readJsonLines(options.predictions);
  const report = evaluateMemoryWritePredictions(cases, predictions);
  const gate = evaluateMemoryWriteGate(report, {
    writePrecision: options.writePrecision,
  });
  if (options.json) console.log(JSON.stringify({ report, gate }, null, 2));
  else printReport(report, gate);
  if (!gate.passed) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_CASES,
  parseArgs,
  readJsonLines,
  validateCases,
  printReport,
};
