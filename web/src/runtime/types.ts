export type RunStatus = "idle" | "connecting" | "running" | "done" | "error" | "aborted";

export interface LiveMessage {
  agentId: string;
  invocationId?: string;
  text: string;
  status: "thinking" | "streaming" | "done" | "error";
  thinking?: string;
  tools?: RunTool[];
  progress?: RunProgressItem[];
}

export interface RunTool {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  detail?: string;
}

export interface RunProgressItem {
  id: string;
  label: string;
  status: string;
}

export interface SessionRun {
  sessionId: string;
  status: RunStatus;
  startedAt?: number;
  updatedAt: number;
  doneReceived: boolean;
  liveMessages: Record<string, LiveMessage>;
  invocations: Record<string, string>;
  notices: string[];
  optimisticUser?: {
    agentId: string;
    content: string;
  };
  error?: string;
}

export interface SessionRunState {
  runs: Record<string, SessionRun>;
}

export type SessionRunAction =
  | { type: "run/started"; sessionId: string; startedAt: number }
  | { type: "user/submitted"; sessionId: string; agentId: string; content: string }
  | {
      type: "agent/started";
      sessionId: string;
      agentId: string;
      invocationId?: string;
    }
  | { type: "message/delta"; sessionId: string; agentId: string; text: string }
  | { type: "thinking/delta"; sessionId: string; agentId: string; text: string }
  | {
      type: "tool/started";
      sessionId: string;
      agentId: string;
      toolId: string;
      toolName: string;
      detail?: string;
    }
  | {
      type: "tool/finished";
      sessionId: string;
      agentId: string;
      toolId: string;
      failed?: boolean;
      detail?: string;
    }
  | {
      type: "progress/updated";
      sessionId: string;
      agentId: string;
      items: RunProgressItem[];
    }
  | {
      type: "agent/finished";
      sessionId: string;
      agentId: string;
      failed?: boolean;
    }
  | { type: "notice/received"; sessionId: string; message: string }
  | { type: "run/done"; sessionId: string }
  | { type: "run/failed"; sessionId: string; error: string }
  | { type: "run/aborted"; sessionId: string }
  | { type: "run/synced"; sessionId: string }
  | { type: "session/rekeyed"; from: string; to: string }
  | { type: "session/disposed"; sessionId: string };
