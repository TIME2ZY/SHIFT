import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type PropsWithChildren, useState } from "react";
import { ToastProvider } from "../features/notifications/ToastProvider";
import { SessionRunProvider } from "../runtime/session-run-provider";

export function AppProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionRunProvider>{children}</SessionRunProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
