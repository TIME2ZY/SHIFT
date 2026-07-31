import type { AgentSummary } from "./types";

export function agentMentionLabel(agent: AgentSummary): string {
  return agent.mention || agent.label || agent.id;
}

export function findExplicitLeadingAgent(
  prompt: string,
  agents: AgentSummary[]
): AgentSummary | null {
  const text = prompt.trimStart();
  if (!text.startsWith("@")) return null;

  const candidates = [...agents].sort(
    (left, right) => agentMentionLabel(right).length - agentMentionLabel(left).length
  );

  for (const agent of candidates) {
    const labels = new Set([agentMentionLabel(agent), agent.id]);
    for (const label of labels) {
      const token = `@${label}`;
      if (
        text.localeCompare(token, undefined, { sensitivity: "accent" }) === 0 ||
        text.toLocaleLowerCase().startsWith(`${token.toLocaleLowerCase()} `) ||
        text.toLocaleLowerCase().startsWith(`${token.toLocaleLowerCase()}\n`)
      ) {
        return agent;
      }
    }
  }

  return null;
}
