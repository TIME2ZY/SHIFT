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
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const short = value.length > digits ? value.slice(-digits) : value;

  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => undefined
    );
  };

  return (
    <button
      type="button"
      className="react-id-chip"
      title={value}
      aria-label={label ? `复制${label} ${short}` : `复制标识 ${short}`}
      onClick={copy}
    >
      <code>{short}</code>
      <span className="react-id-chip-state" aria-hidden="true">
        {copied ? "已复制" : "复制"}
      </span>
    </button>
  );
}
