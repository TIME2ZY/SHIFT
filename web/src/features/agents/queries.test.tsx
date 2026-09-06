import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { queryKeys } from "../../shared/api/queryKeys";
import { useRefreshAgentMutation } from "./queries";

afterEach(() => vi.unstubAllGlobals());

it("refresh posts authenticated JSON and updates the shared roster", async () => {
  const client = new QueryClient();
  const agents = [{ id: "gemini", routable: true, label: "Gemini" }];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options: RequestInit) => {
      expect(new Headers(options.headers).get("content-type")).toBe("application/json");
      expect(options.method).toBe("POST");
      expect(JSON.parse(String(options.body))).toEqual({ agent: "gemini" });
      return new Response(JSON.stringify({ agents }), { status: 202 });
    })
  );
  const { result } = renderHook(() => useRefreshAgentMutation(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await result.current.mutateAsync("gemini");
  });
  await waitFor(() => expect(client.getQueryData(queryKeys.agents.all)).toEqual(agents));
  client.clear();
});
