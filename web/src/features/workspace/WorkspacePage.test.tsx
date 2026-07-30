import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../notifications/ToastProvider";
import { WorkspacePage } from "./WorkspacePage";

const DIFF = [
  "diff --git a/src/alpha.ts b/src/alpha.ts",
  "index 1111111..2222222 100644",
  "--- a/src/alpha.ts",
  "+++ b/src/alpha.ts",
  "@@ -1,2 +1,3 @@",
  " const alpha = 1;",
  "-const oldName = true;",
  "+const newName = true;",
  "+export { alpha };",
  "diff --git a/src/beta.ts b/src/beta.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/beta.ts",
  "@@ -0,0 +1 @@",
  "+export const beta = 2;",
].join("\n");

function renderPage(worktreeAttached = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChat = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WorkspacePage
          sessionId="session-1"
          sessionTitle="React migration"
          worktreeAttached={worktreeAttached}
          onOpenChat={onOpenChat}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  return { onOpenChat };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WorkspacePage", () => {
  it("shows branch metadata, summary, and selectable file diffs", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.startsWith("/api/project?")) {
        return Promise.resolve(new Response(JSON.stringify({ dir: "C:/projects/shift" })));
      }
      if (input.endsWith("/worktree/status")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              branch: "shift/session-1",
              baseDir: "C:/projects/shift",
              clean: false,
              previewUrl: "http://localhost:4173",
            })
          )
        );
      }
      if (input.endsWith("/worktree/diff")) {
        return Promise.resolve(
          new Response(JSON.stringify({ diff: DIFF, totalChars: DIFF.length }))
        );
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByRole("heading", { name: "shift/session-1" })).toBeInTheDocument();
    expect(screen.getAllByText("src/alpha.ts")).toHaveLength(2);
    expect(screen.getByText("src/beta.ts")).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "改动摘要" });
    expect(within(summary).getByText("+3")).toBeInTheDocument();
    expect(within(summary).getByText("−1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开预览" })).toHaveAttribute(
      "href",
      "http://localhost:4173"
    );
    expect(screen.getByLabelText("src/alpha.ts Diff")).toHaveTextContent("const newName = true");

    await userEvent.click(screen.getByRole("button", { name: /src\/beta\.ts/ }));
    expect(screen.getByLabelText("src/beta.ts Diff")).toHaveTextContent("export const beta = 2");
  });

  it("supports project editing before a worktree exists", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/project" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ dir: "D:/next-project" })));
      }
      if (input.startsWith("/api/project?")) {
        return Promise.resolve(new Response(JSON.stringify({ dir: "C:/projects/shift" })));
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { onOpenChat } = renderPage(false);
    expect(await screen.findByText("这个会话还没有隔离工作区")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "编辑" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "项目目录" }));
    await userEvent.type(screen.getByRole("textbox", { name: "项目目录" }), "D:/next-project");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/project",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "session-1", dir: "D:/next-project" }),
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "返回对话" }));
    expect(onOpenChat).toHaveBeenCalledOnce();
  });

  it("requires confirmation before discarding the worktree", async () => {
    let discarded = false;
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input.startsWith("/api/project?")) {
        return Promise.resolve(new Response(JSON.stringify({ dir: "C:/projects/shift" })));
      }
      if (input.endsWith("/worktree/status")) {
        return Promise.resolve(
          discarded
            ? new Response(JSON.stringify({ error: "missing" }), { status: 404 })
            : new Response(
                JSON.stringify({
                  branch: "shift/session-1",
                  baseDir: "C:/projects/shift",
                  clean: false,
                })
              )
        );
      }
      if (input.endsWith("/worktree/diff")) {
        return Promise.resolve(new Response(JSON.stringify({ diff: DIFF })));
      }
      if (input.endsWith("/worktree/discard") && init?.method === "POST") {
        discarded = true;
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage();
    await screen.findByRole("heading", { name: "shift/session-1" });
    await userEvent.click(screen.getByRole("button", { name: "丢弃 worktree" }));

    expect(window.confirm).toHaveBeenCalledWith(
      "确认丢弃当前 worktree？所有未提交改动都会被移除。"
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/session-1/worktree/discard",
        expect.objectContaining({ method: "POST" })
      )
    );
    expect(await screen.findByText("这个会话还没有隔离工作区")).toBeInTheDocument();
  });
});
