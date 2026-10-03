import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MaterialsEditor } from "./MaterialsEditor";
import { ReportArtifact } from "./ReportArtifact";
import type { DelegationTask } from "./types";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.querySelector('meta[name="shift-ui-token"]')?.remove();
});
const input = {
  id: "source",
  ownerTaskId: "task",
  name: "notes.md",
  locator: "/source",
  contentHash: "a".repeat(64),
  byteLength: 5,
  createdAt: "",
};
const task = { id: "task", state: "draft", revision: 3, inputs: [] } as unknown as DelegationTask;
function wrap(element: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}
it("adds pasted material with draft CAS and removes a reference without changing its source", async () => {
  const fetchMock = vi.fn(
    async (_url: string, _options: RequestInit = {}) => new Response(JSON.stringify({ task }))
  );
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  const rendered = wrap(<MaterialsEditor task={task} disabled={false} />);
  await user.type(screen.getByRole("textbox", { name: "材料正文" }), "材料原文");
  await user.click(screen.getByRole("button", { name: "添加材料" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    name: "材料.txt",
    content: "材料原文",
    expectedRevision: 3,
  });
  rendered.unmount();
  wrap(<MaterialsEditor task={{ ...task, inputs: [input], revision: 4 }} disabled={false} />);
  await user.click(screen.getByRole("button", { name: "移除 notes.md" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1][0]).toBe("/api/tasks/task/inputs/source");
  expect(fetchMock.mock.calls[1][1]?.method).toBe("DELETE");
});
it("uploads UTF-8 Markdown and rejects unsupported formats, oversized files and invalid UTF-8", async () => {
  const fetchMock = vi.fn(async (_url: string, _options: RequestInit = {}) => new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  wrap(<MaterialsEditor task={task} disabled={false} />);
  const user = userEvent.setup({ applyAccept: false }),
    picker = screen.getByLabelText("上传材料");
  await user.upload(picker, new File(["原文"], "notes.md", { type: "text/markdown" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).content).toBe("原文");
  await user.upload(picker, new File(["pdf"], "file.pdf"));
  expect(await screen.findByRole("alert")).toHaveTextContent("仅支持 TXT");
  await user.upload(picker, new File(["x".repeat(65537)], "huge.txt"));
  expect(await screen.findByRole("alert")).toHaveTextContent("64 KiB");
  await user.upload(picker, new File([new Uint8Array([255])], "bad.txt"));
  await waitFor(() => expect(screen.getByRole("alert")).not.toHaveTextContent("64 KiB"));
  expect(fetchMock).toHaveBeenCalledOnce();
});
it("frozen input versions stay visible and have no upload or removal controls", async () => {
  wrap(<MaterialsEditor task={{ ...task, state: "queued", inputs: [input] }} disabled={false} />);
  expect(screen.getByText(/版本已冻结/)).toBeVisible();
  expect(screen.getByText("notes.md")).toBeVisible();
  expect(screen.queryByRole("button", { name: /移除/ })).toBeNull();
  expect(screen.queryByLabelText("上传材料")).toBeNull();
});
const artifact = {
  id: "report",
  runId: "run",
  kind: "markdown_report",
  locator: "/report",
  summary: "报告",
  contentHash: "b".repeat(64),
  metadata: {},
};
it("previews sanitized report and downloads through authenticated fetch, then releases the Blob URL", async () => {
  const meta = document.createElement("meta");
  meta.name = "shift-ui-token";
  meta.content = "token";
  document.head.append(meta);
  const fetchMock = vi.fn(
    async (url: string, _options?: RequestInit) =>
      new Response(
        url.endsWith("/download")
          ? "# Report"
          : JSON.stringify({ markdown: "# Report\n\n<img src=x onerror=alert(1)>" })
      )
  );
  vi.stubGlobal("fetch", fetchMock);
  const createObjectURL = vi.fn(() => "blob:report"),
    revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  wrap(<ReportArtifact taskId="task" artifact={artifact} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "预览报告" }));
  expect(await screen.findByRole("heading", { name: "Report" })).toBeVisible();
  expect(document.querySelector("img")).toBeNull();
  await user.click(screen.getByRole("button", { name: "下载 Markdown" }));
  await waitFor(() => expect(click).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[1][0]).toBe("/api/tasks/task/artifacts/report/download");
  expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("X-Shift-UI-Token")).toBe("token");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
});
it("surfaces rejected report downloads without creating an unauthenticated fallback", async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ error: "成果版本已改变" }), { status: 409 })
  );
  vi.stubGlobal("fetch", fetchMock);
  wrap(<ReportArtifact taskId="task" artifact={artifact} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "下载 Markdown" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("成果版本已改变");
  expect(fetchMock).toHaveBeenCalledOnce();
});
