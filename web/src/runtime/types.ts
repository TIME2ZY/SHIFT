import type { UiLiveMessageStatus, UiRunStatus } from "../shared/contracts/run-status";

/** UI run status — see shared/contracts/run-status.ts for server mapping. */
export type RunStatus = UiRunStatus;

export interface LiveMessage {
  agentId: string;
  invocationId?: string;
  text: string;
  status: UiLiveMessageStatus;
  thinking?: string;
  tools?: RunTool[];
  timeline?: RunTimelineItem[];
  progress?: RunProgressItem[];
  changedFiles?: RunChangedFile[];
}

export interface RunTool {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  /** Human-readable title from provider (may differ from stable name). */
  title?: string;
  /** Vendor label e.g. "Subagent". */
  label?: string;
  /** Vendor kind e.g. "task" | "background_task_action". */
  toolKind?: string;
}

export interface RunProgressItem {
  id: string;
  label: string;
  status: string;
}

export type RunTimelineItem =
  | {
      id: string;
      type: "thinking";
      text: string;
    }
  | {
      id: string;
      type: "text";
      text: string;
    }
  | {
      id: string;
      type: "tool";
      toolId: string;
    };

export interface RunChangedFile {
  path: string;
  changeType?: string;
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
  | {
      type: "message/delta";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      text: string;
    }
  | {
      type: "thinking/delta";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      text: string;
    }
  | {
      type: "tool/started";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      toolId: string;
      toolName: string;
      input?: Record<string, unknown>;
      title?: string;
      label?: string;
      toolKind?: string;
    }
  | {
      type: "tool/finished";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      toolId: string;
      toolName?: string;
      failed?: boolean;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
      title?: string;
      label?: string;
      toolKind?: string;
    }
  | {
      type: "progress/updated";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      items: RunProgressItem[];
    }
  | {
      type: "file/changed";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      path: string;
      changeType?: string;
    }
  | {
      type: "agent/finished";
      sessionId: string;
      agentId: string;
      invocationId?: string;
      failed?: boolean;
    }
  | { type: "notice/received"; sessionId: string; message: string }
  | { type: "run/done"; sessionId: string }
  | { type: "run/failed"; sessionId: string; error: string }
  | { type: "run/aborted"; sessionId: string }
  | { type: "run/synced"; sessionId: string }
  | { type: "session/rekeyed"; from: string; to: string }
  | { type: "session/disposed"; sessionId: string };
