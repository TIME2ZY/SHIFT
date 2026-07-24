const assert = require("node:assert/strict");
const test = require("node:test");

const { createStorage } = require("../../src/storage");
const {
  parseMemoryBlocks,
  applyMemoryBlocks,
} = require("../../src/agents/memory-block");

test("parseMemoryBlocks extracts valid product memories", () => {
  const text = `
Some prose.

\`\`\`memory
kind: decision
topic: storage-primary
content: SQLite is the online write path
\`\`\`

\`\`\`memory
kind: fact
topic: port
content: |
  Server listens on 8787
\`\`\`

\`\`\`memory
kind: handoff
topic: x
content: should skip auto kind
\`\`\`

\`\`\`memory
kind: decision
content: missing topic
\`\`\`
`;
  const blocks = parseMemoryBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "decision");
  assert.equal(blocks[0].topic, "storage-primary");
  assert.match(blocks[1].content, /8787/);
});

test("applyMemoryBlocks writes products and supersedes by topic", () => {
  const storage = createStorage({ file: ":memory:" });
  storage.threads.create({ id: "t1" });
  const events = [];
  try {
    const first = applyMemoryBlocks({
      text: "```memory\nkind: decision\ntopic: storage-primary\ncontent: first decision about sqlite\n```",
      threadId: "t1",
      invocationId: "inv-1",
      agentId: "codex",
      memoryService: storage.memory,
      sendSse: (event, payload) => events.push({ event, payload }),
    });
    assert.equal(first.blockWritten, 1);
    assert.equal(first.blockParsed, 1);
    assert.equal(events[0].event, "memory");

    const second = applyMemoryBlocks({
      text: "```memory\nkind: decision\ntopic: storage-primary\ncontent: second decision about sqlite\n```",
      threadId: "t1",
      invocationId: "inv-2",
      agentId: "codex",
      memoryService: storage.memory,
    });
    assert.equal(second.blockWritten, 1);
    assert.equal(storage.memory.listActive("t1").length, 1);
    assert.match(storage.memory.listActive("t1")[0].content, /second decision/);
  } finally {
    storage.close();
  }
});

test("applyMemoryBlocks skips when memory service missing", () => {
  const stats = applyMemoryBlocks({
    text: "```memory\nkind: fact\ntopic: x\ncontent: something long enough\n```",
    threadId: "t1",
    memoryService: null,
  });
  assert.equal(stats.blockParsed, 1);
  assert.equal(stats.blockSkipped, 1);
  assert.equal(stats.blockWritten, 0);
});
