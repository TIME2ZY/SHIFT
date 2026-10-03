"use strict";
const { randomUUID } = require("node:crypto");
function createTaskInputs({ db, transaction, draft, event, get }) {
  function list(id) {
    return db
      .prepare("SELECT * FROM task_inputs WHERE task_id=? ORDER BY created_at,id")
      .all(id)
      .map((row) => ({
        id: row.id,
        ownerTaskId: row.owner_task_id,
        name: row.name,
        locator: row.locator,
        contentHash: row.content_hash,
        byteLength: row.byte_length,
        createdAt: row.created_at,
      }));
  }
  function insert(taskId, input) {
    db.prepare("INSERT INTO task_inputs VALUES (?,?,?,?,?,?,?,?)").run(
      taskId,
      input.id,
      input.ownerTaskId,
      input.name,
      input.locator,
      input.contentHash,
      input.byteLength,
      input.createdAt
    );
  }
  return {
    list,
    inherit(taskId, inputs) {
      for (const input of inputs) insert(taskId, input);
    },
    add(id, input, revision) {
      return transaction(() => {
        draft(id, revision);
        const existing = list(id);
        if (
          existing.length >= 20 ||
          existing.reduce((sum, row) => sum + row.byteLength, 0) + input.byteLength > 256 * 1024
        )
          throw Object.assign(new Error("材料最多 20 份，合计不超过 256 KiB。"), {
            statusCode: 400,
            code: "INPUT_LIMIT",
          });
        if (
          typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 200 ||
          !/^[a-f0-9]{64}$/.test(input.contentHash) ||
          !Number.isInteger(input.byteLength) ||
          input.byteLength < 1 ||
          input.byteLength > 64 * 1024 ||
          typeof input.locator !== "string" ||
          !input.locator
        )
          throw Object.assign(new Error("材料引用无效。"), {
            statusCode: 400,
            code: "INVALID_INPUT",
          });
        insert(id, {
          ...input,
          id: randomUUID(),
          ownerTaskId: id,
          name: input.name.trim(),
          createdAt: new Date().toISOString(),
        });
        event(id, "input_added", { name: input.name, contentHash: input.contentHash });
        return get(id);
      });
    },
    remove(id, inputId, revision) {
      return transaction(() => {
        draft(id, revision);
        const result = db
          .prepare("DELETE FROM task_inputs WHERE task_id=? AND id=?")
          .run(id, inputId);
        if (!result.changes)
          throw Object.assign(new Error("材料不存在。"), {
            statusCode: 404,
            code: "INPUT_NOT_FOUND",
          });
        event(id, "input_removed", { inputId });
        return get(id);
      });
    },
  };
}
module.exports = { createTaskInputs };
