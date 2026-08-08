import { afterEach, describe, expect, it, vi } from "vitest";
import { formatToolResultForDisplay, runChatStream } from "./chat-stream";
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

describe("formatToolResultForDisplay", () => {
  it("prefers TaskOutput.Result.output text", () => {
    const text = formatToolResultForDisplay({
      type: "TaskOutput",
      Result: {
        status: "completed",
        exit_code: 0,
        duration_secs: 5.3,
        output: "18 top-level entries",
      },
    });
    expect(text).toContain("completed");
    expect(text).toContain("18 top-level entries");
  });
});

describe("runChatStream", () => {
  it("maps subagent tool display fields into the session run store", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'event: session\ndata: {"sessionId":"s2"}\n\n',
          'event: agent-start\ndata: {"agent":"grok","invocationId":"i2"}\n\n',
          'event: agent-event\ndata: {"type":"tool.started","agent":"grok","invocationId":"i2","toolId":"sp1","toolName":"spawn_subagent","title":"List top-level","label":"Subagent","toolKind":"task","args":{"description":"List top-level","subagent_type":"explore"}}\n\n',
          'event: agent-event\ndata: {"type":"tool.finished","agent":"grok","invocationId":"i2","toolId":"sp1","toolName":"spawn_subagent","title":"List top-level","label":"Subagent","toolKind":"task","status":"ok","args":{"description":"List top-level","subagent_type":"explore","run_in_background":true},"result":{"type":"Text","text":"Subagent started in background.\\nsubagent_id: abc"}}\n\n',
          'event: agent-exit\ndata: {"agent":"grok","invocationId":"i2","code":0}\n\n',
          "event: done\ndata: {}\n\n",
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = createSessionRunStore();
    const controller = store.startController("s2");
    await runChatStream({ sessionId: "s2", agentId: "grok", prompt: "go" }, store, controller);
    expect(store.getSnapshot().runs.s2.liveMessages.i2.tools).toMatchObject([
      {
        id: "sp1",
        name: "spawn_subagent",
        title: "List top-level",
        label: "Subagent",
        toolKind: "task",
        status: "done",
        input: {
          description: "List top-level",
          subagent_type: "explore",
          run_in_background: true,
        },
      },
    ]);
    expect(store.getSnapshot().runs.s2.liveMessages.i2.tools?.[0]?.output).toMatch(/subagent_id/);
  });

  it("merges tool.finished args when start had empty args", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'event: session\ndata: {"sessionId":"s3"}\n\n',
          'event: agent-start\ndata: {"agent":"grok","invocationId":"i3"}\n\n',
          'event: agent-event\ndata: {"type":"tool.started","agent":"grok","invocationId":"i3","toolId":"t9","toolName":"spawn_subagent","args":{}}\n\n',
          'event: agent-event\ndata: {"type":"tool.finished","agent":"grok","invocationId":"i3","toolId":"t9","toolName":"spawn_subagent","title":"Explore","label":"Subagent","toolKind":"task","status":"ok","args":{"subagent_type":"explore","description":"Explore"},"result":{"type":"Text","text":"ok"}}\n\n',
          "event: done\ndata: {}\n\n",
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = createSessionRunStore();
    const controller = store.startController("s3");
    await runChatStream({ sessionId: "s3", agentId: "grok", prompt: "go" }, store, controller);
    expect(store.getSnapshot().runs.s3.liveMessages.i3.tools?.[0]).toMatchObject({
      id: "t9",
      title: "Explore",
      label: "Subagent",
      input: { subagent_type: "explore", description: "Explore" },
      output: "ok",
    });
  });

  it("maps canonical text events into the session run store", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        sseResponse([
          'event: session\ndata: {"sessionId":"s1"}\n\n',
          'event: agent-start\ndata: {"agent":"codex","invocationId":"i1"}\n\n',
          'event: agent-event\ndata: {"type":"thinking.delta","agent":"codex","invocationId":"i1","text":"plan"}\n\n',
          'event: agent-event\ndata: {"type":"commentary.delta","agent":"codex","invocationId":"i1","text":"working"}\n\n',
          'event: agent-event\ndata: {"type":"tool.started","agent":"codex","invocationId":"i1","toolId":"t1","toolName":"read","args":{"path":"src/index.js"}}\n\n',
          'event: agent-event\ndata: {"type":"progress.update","agent":"codex","invocationId":"i1","items":[{"id":"p1","label":"Read","status":"completed"}]}\n\n',
          'event: agent-event\ndata: {"type":"tool.finished","agent":"codex","invocationId":"i1","toolId":"t1","toolName":"read","status":"completed","result":{"ok":true}}\n\n',
          'event: agent-event\ndata: {"type":"file.changed","agent":"codex","invocationId":"i1","path":"src/index.js","changeType":"modified"}\n\n',
          'event: agent-event\ndata: {"type":"text.delta","agent":"codex","invocationId":"i1","text":"hello"}\n\n',
          'event: agent-exit\ndata: {"agent":"codex","invocationId":"i1","code":0}\n\n',
          "event: done\ndata: {}\n\n",
        ])
      );
    vi.stubGlobal("fetch", fetchMock);
    const store = createSessionRunStore();
    const controller = store.startController("s1");

    const result = await runChatStream(
      {
        sessionId: "s1",
        agentId: "codex",
        prompt: "go",
        clientTurnId: "turn-123",
      },
      store,
      controller
    );

    expect(result.doneReceived).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      sessionId: "s1",
      clientTurnId: "turn-123",
    });
    expect(store.getSnapshot().runs.s1.status).toBe("done");
    expect(store.getSnapshot().runs.s1.liveMessages.i1).toMatchObject({
      text: "hello",
      status: "done",
      thinking: "plan",
      commentary: "working",
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
        { id: "commentary-1", type: "commentary", text: "working" },
        { id: "tool-t1", type: "tool", toolId: "t1" },
        { id: "text-3", type: "text", text: "hello" },
      ],
      progress: [{ id: "p1", label: "Read", status: "completed" }],
      changedFiles: [{ path: "src/index.js", changeType: "modified" }],
    });
  });

  it("rejects a stream event that is missing invocationId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['event: agent-start\ndata: {"agent":"codex"}\n\n']))
    );
    const store = createSessionRunStore();
    const controller = store.startController("s1");

    await expect(
      runChatStream({ sessionId: "s1", agentId: "codex", prompt: "go" }, store, controller)
    ).rejects.toThrow("invocationId");
  });

  it("reports each committed agent exit with its invocation identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'event: agent-start\ndata: {"agent":"codex","invocationId":"i1"}\n\n',
            'event: agent-exit\ndata: {"agent":"codex","invocationId":"i1","code":0}\n\n',
            'event: agent-start\ndata: {"agent":"gemini","invocationId":"i2"}\n\n',
            'event: agent-exit\ndata: {"agent":"gemini","invocationId":"i2","code":0}\n\n',
            'event: agent-start\ndata: {"agent":"codex","invocationId":"i3"}\n\n',
            'event: agent-event\ndata: {"type":"text.delta","agent":"codex","invocationId":"i3","text":"new"}\n\n',
            "event: done\ndata: {}\n\n",
          ])
        )
    );
    const store = createSessionRunStore();
    const controller = store.startController("s1");
    const onAgentExit = vi.fn();

    await runChatStream({ sessionId: "s1", agentId: "codex", prompt: "go" }, store, controller, {
      onAgentExit,
    });

    expect(onAgentExit.mock.calls).toEqual([
      ["s1", "i1"],
      ["s1", "i2"],
    ]);
    expect(store.getSnapshot().runs.s1.liveMessages.i1.status).toBe("done");
    expect(store.getSnapshot().runs.s1.liveMessages.i3.text).toBe("new");
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
