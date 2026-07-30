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
              text: current.text + action.text,
              status: "streaming",
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
        liveMessages: {},
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
