import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventBodyText, RecallPanel } from "./RecallPanel";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderRecallPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecallPanel sessionId="session-1" />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecallPanel", () => {
  it("lists invocations and loads an event trace on demand", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.startsWith("/api/callbacks/list-invocations?")) {
        return jsonResponse({
          invocations: [
            {
              invocationId: "invocation-1",
              agent: "codex",
              state: "completed",
              eventCount: 2,
              startedAt: "2026-07-30T12:00:00.000Z",
            },
          ],
        });
      }
      if (input.startsWith("/api/callbacks/read-invocation?")) {
        return jsonResponse({
          invocationId: "invocation-1",
          total: 1,
          from: 0,
          limit: 120,
          events: [
            {
              invocationId: "invocation-1",
              sequenceNo: 0,
              kind: "text.delta",
              payload: { text: "实现完成" },
              createdAt: "2026-07-30T12:01:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRecallPanel();
    await userEvent.click(await screen.findByRole("button", { name: /codex/i }));

    expect(await screen.findByText("text.delta")).toBeInTheDocument();
    expect(screen.getByText("实现完成")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("searches session evidence only after submission", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.startsWith("/api/callbacks/list-invocations?")) {
        return jsonResponse({ invocations: [] });
      }
      if (input.startsWith("/api/callbacks/session-search?")) {
        return jsonResponse({
          hits: [
            {
              sourceId: "memory-1",
              layer: "memory",
              kind: "memory.decision",
              snippet: "前端采用 React。",
            },
          ],
          layers: { memory: 1, message: 0, evidence: 0 },
          query: "React",
          limit: 30,
          truncated: false,
          weakQuery: false,
        });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRecallPanel();
    await userEvent.click(screen.getByRole("tab", { name: "搜索证据" }));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索当前对话" }), "React");

    expect(fetchMock).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole("button", { name: "搜索" }));

    expect(await screen.findByText("前端采用 React。")).toBeInTheDocument();
    expect(screen.getByText("记忆 1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("extracts readable event content before falling back to JSON", () => {
    expect(
      eventBodyText({
        invocationId: "i1",
        sequenceNo: 1,
        kind: "tool.finished",
        payload: { output: "done", exitCode: 0 },
      })
    ).toBe("done");
    expect(
      eventBodyText({
        invocationId: "i1",
        sequenceNo: 2,
        kind: "usage.update",
        payload: { totalTokens: 42 },
      })
    ).toContain('"totalTokens": 42');
  });
});
