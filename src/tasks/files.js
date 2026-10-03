"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assertValidOpaqueId } = require("../shared/id-policy");
function fileError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
function contentHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function createTaskFiles({ shiftHome }) {
  const root = path.resolve(shiftHome, "tasks");
  function ensureDirectory(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw fileError("UNSAFE_TASK_PATH", "任务路径必须为普通目录。");
  }
  function directory(id) {
    assertValidOpaqueId(id, "taskId");
    fs.mkdirSync(path.dirname(root), { recursive: true });
    ensureDirectory(root);
    const dir = path.join(root, id);
    ensureDirectory(dir);
    return dir;
  }
  function managedFile(owner, relative) {
    const dir = directory(owner);
    const target = path.resolve(dir, relative);
    const rel = path.relative(dir, target);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
      throw fileError("UNSAFE_TASK_PATH", "文件路径越界。");
    let parent = dir;
    for (const part of path.relative(dir, path.dirname(target)).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);
      ensureDirectory(parent);
    }
    if (
      fs.existsSync(target) &&
      (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink())
    )
      throw fileError("UNSAFE_TASK_PATH", "材料必须为普通文件。");
    return target;
  }
  function verified(locator, expected, hash) {
    if (path.resolve(locator) !== expected)
      throw fileError("UNSAFE_TASK_PATH", "文件不属于此任务引用。");
    const bytes = fs.readFileSync(expected);
    if (contentHash(bytes) !== hash) throw fileError("CONTENT_CHANGED", "材料或成果版本已改变。");
    return bytes;
  }
  return {
    directory,
    storeInput(taskId, { name, content }) {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 200 ||
        typeof content !== "string"
      )
        throw fileError("INVALID_INPUT", "请提供材料名称和 UTF-8 文本。");
      const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      const bytes = Buffer.from(normalized, "utf8");
      if (!normalized.trim() || bytes.length > 64 * 1024)
        throw fileError("INPUT_LIMIT", "单份材料不能为空或超过 64 KiB。");
      const hash = contentHash(bytes),
        locator = managedFile(taskId, path.join("inputs", hash + ".txt"));
      if (fs.existsSync(locator)) verified(locator, locator, hash);
      else fs.writeFileSync(locator, bytes, { flag: "wx" });
      return { name: name.trim(), locator, contentHash: hash, byteLength: bytes.length };
    },
    readInputs(inputs) {
      return inputs.map((input) => {
        if (!/^[a-f0-9]{64}$/.test(input.contentHash))
          throw fileError("INVALID_INPUT", "材料版本格式无效。");
        const target = managedFile(
          input.ownerTaskId,
          path.join("inputs", input.contentHash + ".txt")
        );
        const bytes = verified(input.locator, target, input.contentHash);
        return {
          ...input,
          content: bytes.toString("utf8"),
          lines: bytes.toString("utf8").split("\n"),
        };
      });
    },
    writeReport(taskId, runId, markdown, metadata) {
      assertValidOpaqueId(runId, "runId");
      const locator = managedFile(taskId, path.join("outputs", runId, "report.md"));
      const bytes = Buffer.from(markdown, "utf8");
      fs.writeFileSync(locator, bytes, { flag: "wx" });
      return {
        kind: "markdown_report",
        locator,
        contentHash: contentHash(bytes),
        summary: metadata.title,
        metadata: { ...metadata, runId, fileName: "report.md" },
      };
    },
    readReport(taskId, artifact) {
      if (artifact.kind !== "markdown_report" || artifact.metadata?.runId !== artifact.runId)
        throw fileError("UNSUPPORTED_ARTIFACT", "此成果不支持报告预览。");
      const target = managedFile(taskId, path.join("outputs", artifact.runId, "report.md"));
      return verified(artifact.locator, target, artifact.contentHash).toString("utf8");
    },
  };
}
module.exports = { createTaskFiles, contentHash };
