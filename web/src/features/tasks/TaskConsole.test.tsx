import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskConsole } from "./TaskConsole";
import type { DelegationTask } from "./types";
const contract = {
  workflowId: "software_delivery" as const,
  goal: "Add export",
  deliverables: ["export"],
  acceptanceCriteria: ["valid data"],
  subtasks: [{ id: "export", title: "Export", description: "Add export" }],
};
afterEach(() => vi.unstubAllGlobals());
function fixture({
  state = "draft",
  rejectSave = false,
  busy = false,
}: { state?: DelegationTask["delegationState"]; rejectSave?: boolean; busy?: boolean } = {}) {
  let task: DelegationTask = {
    threadId: "one",
    delegationState: state,
    version: 8,
    contract,
    contractHash: null,
    queueSeq: null,
    parentThreadId: null,
    delegationReason: null,
    executionTraceId: null,
    repairCount: 0,
    team: null,
    result: null,
  };
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(String(options.body)) : {};
      if (method !== "GET") requests.push({ method, url, body });
      if (method === "PATCH") {
        if (rejectSave)
          return new Response(JSON.stringify({ error: "草稿已更新，请刷新后重试。" }), {
            status: 409,
          });
        task = { ...task, contract: body.contract, version: 9 };
      }
      if (url.endsWith("/submit"))
        task = { ...task, delegationState: "queued", version: 10, queueSeq: 1 };
      return new Response(
        JSON.stringify({
          task,
          busy,
          preparingThreadId: busy ? "other" : null,
          recoveryBlocked: false,
        })
      );
    })
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TaskConsole sessionId="one" onRelatedTask={() => undefined} />
    </QueryClientProvider>
  );
  return requests;
}
it("saves edited scope before submitting the returned revision while another task runs", async () => {
  const requests = fixture({ busy: true });
  const goal = await screen.findByRole("textbox", { name: "收敛目标" });
  await userEvent.clear(goal);
  await userEvent.type(goal, "Export CSV");
  await userEvent.click(screen.getByRole("button", { name: "提交委托" }));
  await screen.findByText("排队中");
  expect(requests.map((row) => row.method)).toEqual(["PATCH", "POST"]);
  expect(requests[0].body).toMatchObject({ expectedRevision: 8, contract: { goal: "Export CSV" } });
  expect(requests[1].body.expectedRevision).toBe(9);
  expect(screen.queryByRole("textbox", { name: "收敛目标" })).not.toBeInTheDocument();
});
it("stale save shows the error and never submits a different contract", async () => {
  const requests = fixture({ rejectSave: true });
  await screen.findByRole("button", { name: "提交委托" });
  await userEvent.click(screen.getByRole("button", { name: "提交委托" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("草稿已更新"));
  expect(requests).toHaveLength(1);
});
it("frozen task shows deliverables and acceptance criteria without edit or approval controls", async () => {
  fixture({ state: "running" });
  await screen.findByRole("heading", { name: "Add export" });
  expect(screen.getByRole("heading", { name: "交付物" })).toBeInTheDocument();
  expect(screen.getByText("valid data")).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "取消委托" })).toBeInTheDocument();
});
