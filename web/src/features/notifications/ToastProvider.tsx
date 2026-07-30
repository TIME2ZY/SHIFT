import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type ToastVariant = "default" | "ok" | "error";

interface ToastOptions {
  variant?: ToastVariant;
  ttl?: number;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  show(message: string, options?: ToastOptions): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options: ToastOptions = {}) => {
      if (!message) return;
      const variant = options.variant || "default";
      const id = nextId.current++;
      setItems((current) => [
        ...current.filter((item) => item.message !== message),
        { id, message, variant },
      ]);
      const timer = window.setTimeout(() => dismiss(id), options.ttl ?? 5200);
      timers.current.set(id, timer);
    },
    [dismiss]
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    []
  );

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="react-toast-host" aria-live="polite" aria-label="通知">
        {items.map((item) => (
          <button
            type="button"
            className="react-toast"
            data-variant={item.variant}
            role={item.variant === "error" ? "alert" : "status"}
            key={item.id}
            onClick={() => dismiss(item.id)}
          >
            {item.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within ToastProvider.");
  return toast;
}
