const assert = require("node:assert/strict");
const test = require("node:test");

const { appendMessage, durableMessageMetadata } = require("../../src/storage/message-persistence");

test("durableMessageMetadata keeps only non-canonical message fields", () => {
  assert.deepEqual(
    durableMessageMetadata({
      id: "m1",
      role: "assistant",
      agent: "codex",
      content: "done",
      createdAt: "2026-08-04T00:00:00.000Z",
      messageType: "assistant-final",
      invocationId: "i1",
      usage: { totalTokens: 10 },
    }),
    {
      invocationId: "i1",
      usage: { totalTokens: 10 },
    }
  );
});

test("appendMessage writes one shared recall projection", () => {
  const projected = [];
  const stored = {
    id: "m1",
    threadId: "t1",
    windowId: "w1",
    invocationId: "i1",
    sequenceNo: 4,
    role: "assistant",
    agentId: "codex",
    content: "done",
    createdAt: "2026-08-04T00:00:00.000Z",
    messageType: "assistant-final",
  };
  const storage = {
    messages: {
      append(input) {
        assert.equal(input.id, "m1");
        return stored;
      },
    },
    recall: {
      upsert(input) {
        projected.push(input);
        return input;
      },
    },
  };

  assert.equal(appendMessage(storage, { id: "m1" }), stored);
  assert.deepEqual(projected, [
    {
      threadId: "t1",
      windowId: "w1",
      sourceKind: "message",
      sourceId: "m1",
      title: "assistant:codex",
      content: "done",
      agentId: "codex",
      createdAt: "2026-08-04T00:00:00.000Z",
      metadata: {
        invocationId: "i1",
        sequenceNo: 4,
        role: "assistant",
        messageType: "assistant-final",
      },
    },
  ]);
});
