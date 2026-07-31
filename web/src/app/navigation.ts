import { useCallback, useEffect, useState } from "react";

export type AppPage = "chat" | "workspace";

function pageFromHash(hash: string): AppPage {
  return hash.replace(/^#\/?/, "") === "workspace" ? "workspace" : "chat";
}

export function useAppNavigation() {
  const [page, setPage] = useState<AppPage>(() => pageFromHash(window.location.hash));

  useEffect(() => {
    const sync = () => setPage(pageFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((nextPage: AppPage) => {
    const nextHash = nextPage === "chat" ? "#/chat" : "#/workspace";
    if (window.location.hash === nextHash) {
      setPage(nextPage);
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return { page, navigate };
}
