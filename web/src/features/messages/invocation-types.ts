export interface InvocationThinkingSegment {
  eventNo: number;
  text: string;
}

export interface InvocationChangedFile {
  path: string;
  changeType?: string;
}

export interface InvocationTool {
  toolId: string;
  toolName: string;
  status: "running" | "done" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  startedAt?: string | number;
  finishedAt?: string | number;
  durationMs?: number;
  changedFiles: InvocationChangedFile[];
  outputTruncated?: boolean;
  title?: string;
  label?: string;
  toolKind?: string;
}

export interface InvocationProgressItem {
  id: string;
  label: string;
  status: string;
}

export type InvocationTimelineItem =
  | {
      id: string;
      type: "thinking";
      eventNo: number;
      lastEventNo: number;
      text: string;
    }
  | {
      id: string;
      type: "text";
      eventNo: number;
      lastEventNo: number;
      text: string;
    }
  | {
      id: string;
      type: "tool";
      eventNo: number;
      toolId: string;
    };

export interface InvocationProcess {
  version: 1;
  invocationId: string;
  status: "running" | "done" | "error";
  thinking: {
    text: string;
    segments: InvocationThinkingSegment[];
  };
  tools: InvocationTool[];
  timeline: InvocationTimelineItem[];
  progress: InvocationProgressItem[];
  changedFiles: InvocationChangedFile[];
}
