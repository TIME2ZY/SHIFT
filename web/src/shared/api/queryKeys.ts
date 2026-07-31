export const queryKeys = {
  agents: {
    all: ["agents"] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    list: ["sessions", "list"] as const,
    detail: (sessionId: string) => ["sessions", sessionId] as const,
    messages: (sessionId: string) => ["sessions", sessionId, "messages"] as const,
    usage: (sessionId: string) => ["sessions", sessionId, "usage"] as const,
    memories: (sessionId: string) => ["sessions", sessionId, "memories"] as const,
    memoryInject: (sessionId: string) => ["sessions", sessionId, "memory-inject"] as const,
    workspace: (sessionId: string) => ["sessions", sessionId, "workspace"] as const,
  },
} as const;
