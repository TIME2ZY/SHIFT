export const queryKeys = {
  observability: {
    metrics: ["observability", "metrics"] as const,
  },
  agents: {
    all: ["agents"] as const,
  },
  projects: {
    all: ["projects"] as const,
    active: ["projects", "active"] as const,
    archived: ["projects", "archived"] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    list: (projectKey: string) => ["sessions", "list", projectKey] as const,
    detail: (sessionId: string) => ["sessions", sessionId] as const,
    messages: (sessionId: string) => ["sessions", sessionId, "messages"] as const,
    usage: (sessionId: string) => ["sessions", sessionId, "usage"] as const,
    memories: (sessionId: string) => ["sessions", sessionId, "memories"] as const,
    memoryInject: (sessionId: string) => ["sessions", sessionId, "memory-inject"] as const,
    workspace: (sessionId: string) => ["sessions", sessionId, "workspace"] as const,
    traces: (sessionId: string) => ["sessions", sessionId, "traces"] as const,
    invocationProcess: (sessionId: string, invocationId: string, detail?: "summary" | "full") =>
      detail
        ? (["sessions", sessionId, "invocations", invocationId, "process", detail] as const)
        : (["sessions", sessionId, "invocations", invocationId, "process"] as const),
  },
} as const;
