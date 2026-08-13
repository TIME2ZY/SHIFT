import { useCallback, useEffect, useState } from "react";

export type AppPage = "chat" | "audit";

function pageFromHash(hash: string): AppPage {
  const page = hash.replace(/^#\/?/, "");
  // Retired workspace links land on Audit, which now owns the former nav slot.
  return page === "audit" || page === "workspace" ? "audit" : "chat";
}

export function useAppNavigation() {
  const [page, setPage] = useState<AppPage>(() => pageFromHash(window.location.hash));

  useEffect(() => {
    const sync = () => setPage(pageFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((nextPage: AppPage) => {
    const nextHash = `#/${nextPage}`;
    if (window.location.hash === nextHash) {
      setPage(nextPage);
      return;
    }
    window.location.hash = nextHash;
  }, []);

  return { page, navigate };
}
