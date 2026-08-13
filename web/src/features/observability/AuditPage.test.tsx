import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { AuditPage } from "./AuditPage";

vi.mock("./TraceExplorer", () => ({
  TraceExplorer: () => <div>Trace 工作台</div>,
}));

vi.mock("./queries", () => ({
  useSessionTracesQuery: () => ({ data: { traces: [] }, isPending: false, error: null }),
}));

vi.mock("../memory/queries", () => ({
  useMemoriesQuery: () => ({
    data: {
      memories: [
        { id: "memory-1", kind: "decision", topic: "存储", content: "SQLite 是唯一真相源。" },
      ],
    },
    isPending: false,
    error: null,
  }),
}));

describe("AuditPage", () => {
  it("places trace metrics and read-only Memory in the main audit workspace", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AuditPage
          sessionId="session-1"
          sessionTitle="审计测试"
          agents={[{ id: "codex", label: "Codex" }]}
          onOpenChat={() => undefined}
          onOpenSessions={() => undefined}
          sessionTriggerRef={createRef<HTMLButtonElement>()}
        />
      </QueryClientProvider>
    );

    expect(screen.getByRole("heading", { level: 1, name: "运行与 Memory 审计" })).toBeInTheDocument();
    expect(screen.getByText("Trace 工作台")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "当前 Memory" })).toBeInTheDocument();
    expect(screen.getByText("SQLite 是唯一真相源。")).toBeInTheDocument();
    expect(screen.getByText(/不设人工审核状态/)).toBeInTheDocument();
  });
});
