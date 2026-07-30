const assert = require("node:assert/strict");
const test = require("node:test");
const Database = require("better-sqlite3");
const {
  loadVectorExtension,
  createVectorIndex,
  insertVector,
  searchVector,
  deleteVector,
} = require("../../src/storage/vector-index");

test("sqlite-vec loads and filters KNN candidates by partition scope", () => {
  const db = new Database(":memory:");
  try {
    const availability = loadVectorExtension(db, { required: true });
    assert.equal(availability.available, true);
    assert.match(availability.version, /^v?0\./);

    createVectorIndex(db, {
      tableName: "embedding_vec_test_3",
      dimensions: 3,
    });
    insertVector(db, {
      tableName: "embedding_vec_test_3",
      itemId: 1,
      scopeKey: "thread:a",
      vector: [1, 0, 0],
    });
    insertVector(db, {
      tableName: "embedding_vec_test_3",
      itemId: 2,
      scopeKey: "thread:b",
      vector: [1, 0, 0],
    });
    insertVector(db, {
      tableName: "embedding_vec_test_3",
      itemId: 3,
      scopeKey: "project:p",
      vector: [0.8, 0.2, 0],
    });

    const threadOnly = searchVector(db, {
      tableName: "embedding_vec_test_3",
      vector: [1, 0, 0],
      scopeKeys: ["thread:a"],
      limit: 10,
    });
    assert.deepEqual(
      threadOnly.map((item) => item.itemId),
      [1]
    );

    const threadAndProject = searchVector(db, {
      tableName: "embedding_vec_test_3",
      vector: new Float32Array([1, 0, 0]),
      scopeKeys: ["thread:a", "project:p"],
      limit: 10,
    });
    assert.deepEqual(
      threadAndProject.map((item) => item.itemId),
      [1, 3]
    );
    assert.ok(threadAndProject.every((item) => item.scopeKey !== "thread:b"));

    assert.equal(
      deleteVector(db, { tableName: "embedding_vec_test_3", itemId: 1 }),
      true
    );
  } finally {
    db.close();
  }
});

test("vector indexes isolate dimensions and reject unsafe identifiers", () => {
  const db = new Database(":memory:");
  try {
    loadVectorExtension(db, { required: true });
    createVectorIndex(db, {
      tableName: "embedding_vec_small",
      dimensions: 3,
    });
    createVectorIndex(db, {
      tableName: "embedding_vec_large",
      dimensions: 4,
    });
    assert.throws(
      () =>
        insertVector(db, {
          tableName: "embedding_vec_small",
          itemId: 1,
          scopeKey: "thread:a",
          vector: [1, 0, 0, 0],
        }),
      /dimensions|size/i
    );
    assert.throws(
      () =>
        createVectorIndex(db, {
          tableName: "embedding_vec_bad; DROP TABLE threads",
          dimensions: 3,
        }),
      /Invalid embedding vector table name/
    );
  } finally {
    db.close();
  }
});

test("optional sqlite-vec loading reports degraded availability", () => {
  const db = new Database(":memory:");
  try {
    const availability = loadVectorExtension(db, {
      sqliteVec: {
        load() {
          throw new Error("extension unavailable");
        },
      },
    });
    assert.deepEqual(availability, {
      available: false,
      reason: "extension unavailable",
    });
  } finally {
    db.close();
  }
});
