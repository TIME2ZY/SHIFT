import { initialSessionRunState, sessionRunReducer } from "./session-run-reducer";
import type { SessionRunAction, SessionRunState } from "./types";

export interface SessionRunStore {
  getSnapshot(): SessionRunState;
  subscribe(listener: () => void): () => void;
  dispatch(action: SessionRunAction): void;
  startController(sessionId: string): AbortController;
  isCurrentController(sessionId: string, controller: AbortController): boolean;
  releaseController(sessionId: string, controller: AbortController): boolean;
  abort(sessionId: string): boolean;
  dispose(sessionId: string): void;
}

export function createSessionRunStore(
  initialState: SessionRunState = initialSessionRunState
): SessionRunStore {
  let state = initialState;
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();

  function dispatch(action: SessionRunAction) {
    if (action.type === "session/rekeyed" && action.from !== action.to) {
      const sourceController = controllers.get(action.from);
      if (sourceController) {
        const conflictingController = controllers.get(action.to);
        if (conflictingController && conflictingController !== sourceController) {
          conflictingController.abort();
        }
        controllers.delete(action.from);
        controllers.set(action.to, sourceController);
      }
    }

    const next = sessionRunReducer(state, action);
    if (next === state) return;
    state = next;
    listeners.forEach((listener) => listener());
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    startController(sessionId) {
      controllers.get(sessionId)?.abort();
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      dispatch({ type: "run/started", sessionId, startedAt: Date.now() });
      return controller;
    },
    isCurrentController(sessionId, controller) {
      return controllers.get(sessionId) === controller;
    },
    releaseController(sessionId, controller) {
      if (controllers.get(sessionId) !== controller) return false;
      controllers.delete(sessionId);
      return true;
    },
    abort(sessionId) {
      const controller = controllers.get(sessionId);
      if (!controller) return false;
      controller.abort();
      dispatch({ type: "run/aborted", sessionId });
      return true;
    },
    dispose(sessionId) {
      controllers.get(sessionId)?.abort();
      controllers.delete(sessionId);
      dispatch({ type: "session/disposed", sessionId });
    },
  };
}
