"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INSTANCES_DIR = path.join(__dirname, "..", "instances");

function listInstances() {
  return fs
    .readdirSync(INSTANCES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(INSTANCES_DIR, name, "instance.json")))
    .sort();
}

function loadInstance(id) {
  const dir = path.join(INSTANCES_DIR, id);
  const metaFile = path.join(dir, "instance.json");
  if (!fs.existsSync(metaFile)) {
    throw new Error(`unknown live instance: ${id}`);
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const required = [
    "id",
    "repo",
    "baseCommit",
    "issueFile",
    "testPatch",
    "installCommand",
    "testArgs",
    "failToPass",
    "sourceAllowPrefixes",
  ];
  for (const field of required) {
    if (!meta[field]) {
      throw new Error(`instance ${id} is missing required field "${field}"`);
    }
  }
  if (meta.id !== id) {
    throw new Error(`instance ${id} declares id "${meta.id}"`);
  }
  if (!Array.isArray(meta.failToPass) || meta.failToPass.length === 0) {
    throw new Error(`instance ${id} must declare at least one failToPass test`);
  }
  const issueFile = path.join(dir, meta.issueFile);
  const testPatch = path.join(dir, meta.testPatch);
  if (!fs.existsSync(issueFile)) {
    throw new Error(`instance ${id} issue file missing: ${meta.issueFile}`);
  }
  if (!fs.existsSync(testPatch)) {
    throw new Error(`instance ${id} test patch missing: ${meta.testPatch}`);
  }
  return {
    ...meta,
    dir,
    issueText: fs.readFileSync(issueFile, "utf8"),
    testPatchPath: testPatch,
  };
}

module.exports = { listInstances, loadInstance };
