import { useState } from "react";

/**
 * An identifier is provenance, not prose. Show it as a compact mono chip that
 * can be copied in full, so the reading flow carries a name instead of a hash.
 */
export function IdChip({
  value,
  label,
  digits = 8,
}: {
  value: string | null | undefined;
  label?: string;
  digits?: number;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  if (!value) return null;
  const short = value.length > digits ? value.slice(-digits) : value;

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1200);
  };

  return (
    <span className="react-id-chip-wrap">
      <button
        type="button"
        className="react-id-chip"
        title={value}
        aria-label={label ? `复制${label} ${short}` : `复制标识 ${short}`}
        onClick={() => void copy()}
      >
        <code>{short}</code>
        <span className="react-id-chip-state" aria-hidden="true">
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
        </span>
      </button>
      <span className="sr-only" role="status">
        {copyState === "copied" ? "已复制完整标识" : copyState === "failed" ? "复制失败" : ""}
      </span>
    </span>
  );
}
