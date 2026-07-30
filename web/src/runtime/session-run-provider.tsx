import {
  createContext,
  type PropsWithChildren,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import { createSessionRunStore, type SessionRunStore } from "./session-run-store";
import type { SessionRun } from "./types";

const SessionRunContext = createContext<SessionRunStore | null>(null);

export function SessionRunProvider({ children }: PropsWithChildren) {
  const storeRef = useRef<SessionRunStore | null>(null);
  if (!storeRef.current) storeRef.current = createSessionRunStore();

  return (
    <SessionRunContext.Provider value={storeRef.current}>{children}</SessionRunContext.Provider>
  );
}

export function useSessionRunStore(): SessionRunStore {
  const store = useContext(SessionRunContext);
  if (!store) throw new Error("SessionRunProvider is missing.");
  return store;
}

export function useSessionRun(sessionId: string | null): SessionRun | null {
  const store = useSessionRunStore();
  return useSyncExternalStore(
    store.subscribe,
    () => (sessionId ? (store.getSnapshot().runs[sessionId] ?? null) : null),
    () => null
  );
}
