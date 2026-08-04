import type { AgentSummary } from "./types";
import geminiLogo from "../../assets/agent-logos/gemini.svg";
import grokLogo from "../../assets/agent-logos/grok.svg";
import openaiLogo from "../../assets/agent-logos/openai.svg";
import opencodeLogo from "../../assets/agent-logos/opencode.svg";

const KNOWN_AGENT_SLOTS: Record<string, number> = {
  codex: 1,
  gemini: 2,
  grok: 3,
  opencode: 4,
};

export function agentColorSlot(agentId: string): number {
  const normalized = agentId.trim().toLocaleLowerCase();
  if (KNOWN_AGENT_SLOTS[normalized]) return KNOWN_AGENT_SLOTS[normalized];
  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (hash % 6) + 1;
}

export function resolveAgent(
  agentId: string | undefined,
  agentLabel: string | undefined,
  agents: AgentSummary[]
): AgentSummary | null {
  const candidates = [agentId, agentLabel]
    .filter(Boolean)
    .map((value) => value!.toLocaleLowerCase());
  return (
    agents.find((agent) =>
      [agent.id, agent.label, agent.mention]
        .filter(Boolean)
        .some((value) => candidates.includes(value!.toLocaleLowerCase()))
    ) || null
  );
}

interface AgentAvatarProps {
  agentId: string;
  label?: string;
  compact?: boolean;
  prominent?: boolean;
}

const BRAND_LOGOS: Record<string, { name: string; src: string }> = {
  codex: { name: "OpenAI", src: openaiLogo },
  openai: { name: "OpenAI", src: openaiLogo },
  gemini: { name: "Google Gemini", src: geminiLogo },
  grok: { name: "Grok", src: grokLogo },
  opencode: { name: "OpenCode", src: opencodeLogo },
};

export function AgentAvatar({ agentId, label, compact, prominent }: AgentAvatarProps) {
  const normalized = agentId.toLocaleLowerCase();
  const brand = BRAND_LOGOS[normalized];
  const initial = (label || agentId || "A").trim().charAt(0).toLocaleUpperCase();

  return (
    <span
      className={`agent-avatar${compact ? " agent-avatar-compact" : ""}${
        prominent ? " agent-avatar-prominent" : ""
      }`}
      data-agent-color={agentColorSlot(agentId)}
      data-agent-brand={brand ? normalized : undefined}
      title={label || agentId}
      aria-hidden="true"
    >
      {brand ? (
        <img src={brand.src} alt="" draggable={false} />
      ) : (
        <span className="agent-avatar-initial">{initial}</span>
      )}
    </span>
  );
}

/** Soft person mark — sits outside bubbles, not a solid CTA chip. */
export function UserAvatar({ compact }: { compact?: boolean }) {
  return (
    <span
      className={`user-avatar${compact ? " user-avatar-compact" : ""}`}
      title="你"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="9" r="3.25" />
        <path d="M6.75 18.25c.85-2.7 2.85-4 5.25-4s4.4 1.3 5.25 4" />
      </svg>
    </span>
  );
}
