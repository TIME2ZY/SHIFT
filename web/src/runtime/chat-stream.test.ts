import { afterEach, describe, expect, it, vi } from "vitest";
import { runChatStream } from "./chat-stream";
import { createSessionRunStore } from "./session-run-store";

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join("")));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runChatStream", () => {
  it("maps canonical text events into the session run store", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: session\ndata: {"sessionId":"s1"}\n\n',
            'event: agent-start\ndata: {"agent":"codex","invocationId":"i1"}\n\n',
            'event: agent-event\ndata: {"type":"thinking.delta","agent":"codex","text":"plan"}\n\n',
            'event: agent-event\ndata: {"type":"tool.started","agent":"codex","invocationId":"i1","toolId":"t1","toolName":"read","args":{"path":"src/index.js"}}\n\n',
            'event: agent-event\ndata: {"type":"progress.update","agent":"codex","items":[{"id":"p1","label":"Read","status":"completed"}]}\n\n',
            'event: agent-event\ndata: {"type":"tool.finished","agent":"codex","invocationId":"i1","toolId":"t1","toolName":"read","status":"completed","result":{"ok":true}}\n\n',
            'event: agent-event\ndata: {"type":"file.changed","agent":"codex","invocationId":"i1","path":"src/index.js","changeType":"modified"}\n\n',
            'event: agent-event\ndata: {"type":"text.delta","agent":"codex","text":"hello"}\n\n',
            'event: agent-exit\ndata: {"agent":"codex","code":0}\n\n',
            "event: done\ndata: {}\n\n",
          ])
        )
    );
    const store = createSessionRunStore();
    const controller = store.startController("s1");

    const result = await runChatStream(
      { sessionId: "s1", agentId: "codex", prompt: "go" },
      store,
      controller
    );

    expect(result.doneReceived).toBe(true);
    expect(store.getSnapshot().runs.s1.status).toBe("done");
    expect(store.getSnapshot().runs.s1.liveMessages.codex).toMatchObject({
      text: "hello",
      status: "done",
      thinking: "plan",
      invocationId: "i1",
      tools: [
        {
          id: "t1",
          name: "read",
          status: "done",
          input: { path: "src/index.js" },
          output: '{\n  "ok": true\n}',
        },
      ],
      timeline: [
        { id: "thinking-0", type: "thinking", text: "plan" },
        { id: "tool-t1", type: "tool", toolId: "t1" },
        { id: "text-2", type: "text", text: "hello" },
      ],
      progress: [{ id: "p1", label: "Read", status: "completed" }],
      changedFiles: [{ path: "src/index.js", changeType: "modified" }],
    });
  });

  it("rejects a stream that closes before done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['event: agent-start\ndata: {"agent":"codex"}\n\n']))
    );
    const store = createSessionRunStore();
    const controller = store.startController("s1");

    await expect(
      runChatStream({ sessionId: "s1", agentId: "codex", prompt: "go" }, store, controller)
    ).rejects.toThrow("完成事件");
  });

  it("forwards memory lifecycle and run error events", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: memory-inject\ndata: {"sessionId":"s1","count":1}\n\n',
            'event: memory\ndata: {"sessionId":"s1","action":"upsert"}\n\n',
            'event: memory-metrics\ndata: {"threadId":"s1","totalWrites":1}\n\n',
            'event: error\ndata: {"message":"provider unavailable"}\n\n',
            "event: done\ndata: {}\n\n",
          ])
        )
    );
    const store = createSessionRunStore();
    const controller = store.startController("s1");
    const seen: string[] = [];

    await runChatStream({ sessionId: "s1", agentId: "codex", prompt: "go" }, store, controller, {
      onMemory: () => seen.push("memory"),
      onMemoryInject: () => seen.push("inject"),
      onMemoryMetrics: () => seen.push("metrics"),
      onRunError: (message) => seen.push(`error:${message}`),
    });

    expect(seen).toEqual(["inject", "memory", "metrics", "error:provider unavailable"]);
    expect(store.getSnapshot().runs.s1.status).toBe("error");
  });
});
