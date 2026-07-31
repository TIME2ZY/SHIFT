import type { LiveMessage, SessionRun, SessionRunAction, SessionRunState } from "./types";

export const initialSessionRunState: SessionRunState = { runs: {} };

function emptyRun(sessionId: string, now = Date.now()): SessionRun {
  return {
    sessionId,
    status: "idle",
    updatedAt: now,
    doneReceived: false,
    liveMessages: {},
    invocations: {},
    notices: [],
  };
}

function updateRun(
  state: SessionRunState,
  sessionId: string,
  updater: (run: SessionRun) => SessionRun
): SessionRunState {
  const current = state.runs[sessionId] ?? emptyRun(sessionId);
  return {
    runs: {
      ...state.runs,
      [sessionId]: updater(current),
    },
  };
}

function appendTimelineText(
  timeline: LiveMessage["timeline"],
  type: "thinking" | "text",
  text: string
): NonNullable<LiveMessage["timeline"]> {
  const current = timeline || [];
  const previous = current.at(-1);
  if (previous?.type === type) {
    return [...current.slice(0, -1), { ...previous, text: previous.text + text }];
  }
  return [...current, { id: `${type}-${current.length}`, type, text }];
}

function appendTimelineTool(
  timeline: LiveMessage["timeline"],
  toolId: string
): NonNullable<LiveMessage["timeline"]> {
  const current = timeline || [];
  if (current.some((item) => item.type === "tool" && item.toolId === toolId)) return current;
  return [...current, { id: `tool-${toolId}`, type: "tool", toolId }];
}

export function sessionRunReducer(
  state: SessionRunState,
  action: SessionRunAction
): SessionRunState {
  const now = Date.now();

  switch (action.type) {
    case "run/started":
      return updateRun(state, action.sessionId, () => ({
        ...emptyRun(action.sessionId, now),
        status: "connecting",
        startedAt: action.startedAt,
      }));

    case "user/submitted":
      return updateRun(state, action.sessionId, (run) => ({
        ...run,
        optimisticUser: {
          agentId: action.agentId,
          content: action.content,
        },
        updatedAt: now,
      }));

    case "agent/started":
      return updateRun(state, action.sessionId, (run) => {
        const message: LiveMessage = {
          agentId: action.agentId,
          invocationId: action.invocationId,
          text: "",
          status: "thinking",
          timeline: [],
        };
        return {
          ...run,
          status: "running",
          updatedAt: now,
          liveMessages: { ...run.liveMessages, [action.agentId]: message },
          invocations: action.invocationId
            ? { ...run.invocations, [action.agentId]: action.invocationId }
            : run.invocations,
        };
      });

    case "message/delta":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId] ?? {
          agentId: action.agentId,
          text: "",
          status: "streaming" as const,
        };
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              invocationId: action.invocationId || current.invocationId,
              text: current.text + action.text,
              timeline: appendTimelineText(current.timeline, "text", action.text),
              status: "streaming",
            },
          },
        };
      });

    case "thinking/delta":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId] ?? {
          agentId: action.agentId,
          text: "",
          status: "thinking" as const,
        };
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              invocationId: action.invocationId || current.invocationId,
              thinking: (current.thinking || "") + action.text,
              timeline: appendTimelineText(current.timeline, "thinking", action.text),
            },
          },
        };
      });

    case "tool/started":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId] ?? {
          agentId: action.agentId,
          text: "",
          status: "thinking" as const,
        };
        const tools = (current.tools || []).filter((tool) => tool.id !== action.toolId);
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              invocationId: action.invocationId || current.invocationId,
              tools: [
                ...tools,
                {
                  id: action.toolId,
                  name: action.toolName,
                  status: "running",
                  input: action.input,
                },
              ],
              timeline: appendTimelineTool(current.timeline, action.toolId),
            },
          },
        };
      });

    case "tool/finished":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId] ?? {
          agentId: action.agentId,
          text: "",
          status: "thinking" as const,
        };
        const existingTools = current.tools || [];
        const matched = existingTools.some((tool) => tool.id === action.toolId);
        const finishedTool = {
          id: action.toolId,
          name: action.toolName || "tool",
          status: action.failed ? ("error" as const) : ("done" as const),
          output: action.output,
          error: action.error,
        };
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              invocationId: action.invocationId || current.invocationId,
              tools: matched
                ? existingTools.map((tool) =>
                    tool.id === action.toolId
                      ? {
                          ...tool,
                          name: action.toolName || tool.name,
                          status: finishedTool.status,
                          output: action.output,
                          error: action.error,
                        }
                      : tool
                  )
                : [...existingTools, finishedTool],
              timeline: appendTimelineTool(current.timeline, action.toolId),
            },
          },
        };
      });

    case "progress/updated":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId] ?? {
          agentId: action.agentId,
          text: "",
          status: "thinking" as const,
        };
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              invocationId: action.invocationId || current.invocationId,
              progress: action.items,
            },
          },
        };
      });

    case "file/changed":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId] ?? {
          agentId: action.agentId,
          text: "",
          status: "thinking" as const,
        };
        const changedFiles = (current.changedFiles || []).filter(
          (file) => file.path !== action.path
        );
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              invocationId: action.invocationId || current.invocationId,
              changedFiles: [
                ...changedFiles,
                { path: action.path, changeType: action.changeType },
              ],
            },
          },
        };
      });

    case "agent/finished":
      return updateRun(state, action.sessionId, (run) => {
        const current = run.liveMessages[action.agentId];
        if (!current) return { ...run, updatedAt: now };
        return {
          ...run,
          updatedAt: now,
          liveMessages: {
            ...run.liveMessages,
            [action.agentId]: {
              ...current,
              status: action.failed ? "error" : "done",
            },
          },
        };
      });

    case "notice/received":
      return updateRun(state, action.sessionId, (run) => ({
        ...run,
        updatedAt: now,
        notices: [...run.notices, action.message],
      }));

    case "run/done":
      return updateRun(state, action.sessionId, (run) => ({
        ...run,
        status: run.status === "error" ? "error" : "done",
        doneReceived: true,
        updatedAt: now,
      }));

    case "run/failed":
      return updateRun(state, action.sessionId, (run) => ({
        ...run,
        status: "error",
        error: action.error,
        updatedAt: now,
      }));

    case "run/aborted":
      return updateRun(state, action.sessionId, (run) => ({
        ...run,
        status: "aborted",
        updatedAt: now,
      }));

    case "run/synced":
      return updateRun(state, action.sessionId, (run) => ({
        ...run,
        optimisticUser: undefined,
        updatedAt: now,
      }));

    case "session/rekeyed": {
      if (action.from === action.to) return state;
      const source = state.runs[action.from];
      if (!source) return state;
      const { [action.from]: _removed, ...remaining } = state.runs;
      return {
        runs: {
          ...remaining,
          [action.to]: { ...source, sessionId: action.to, updatedAt: now },
        },
      };
    }

    case "session/disposed": {
      if (!state.runs[action.sessionId]) return state;
      const { [action.sessionId]: _removed, ...remaining } = state.runs;
      return { runs: remaining };
    }
  }
}

export const sessionRunReducerInternals = { emptyRun };
