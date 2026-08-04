import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentAvatar } from "../agents/AgentAvatar";
import { agentMentionLabel, findExplicitLeadingAgent } from "../agents/routing";
import type { AgentSummary } from "../agents/types";

/** External draft insert request; `id` changes force re-apply even for the same text. */
export interface ComposerDraftSeed {
  id: number;
  text: string;
  useWorktree?: true;
}

interface ComposerProps {
  sessionId: string | null;
  agents: AgentSummary[];
  selectedAgentId: string;
  running: boolean;
  draftSeed?: ComposerDraftSeed | null;
  onDraftSeedApplied?(): void;
  onSend(prompt: string, useWorktree: boolean): Promise<void>;
  onStop(): void;
}

export function Composer({
  sessionId,
  agents,
  selectedAgentId,
  running,
  draftSeed = null,
  onDraftSeedApplied,
  onSend,
  onStop,
}: ComposerProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [worktreeModes, setWorktreeModes] = useState<Record<string, boolean>>({});
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draft = sessionId ? (drafts[sessionId] ?? "") : "";
  const useWorktree = sessionId ? (worktreeModes[sessionId] ?? false) : false;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const explicitAgent = findExplicitLeadingAgent(draft, agents);
  const mentionQuery = draft.match(/^\s*@([^\s]*)$/u)?.[1].toLocaleLowerCase() ?? null;
  const mentionSuggestions = useMemo(() => {
    if (mentionQuery === null || mentionDismissed) return [];
    return agents.filter((agent) => {
      const labels = [agentMentionLabel(agent), agent.label, agent.id];
      return labels.some((label) => label.toLocaleLowerCase().includes(mentionQuery));
    });
  }, [agents, mentionDismissed, mentionQuery]);
  const targetAgent = explicitAgent || selectedAgent;

  function setDraft(value: string) {
    if (!sessionId) return;
    setDrafts((current) => ({ ...current, [sessionId]: value }));
    setMentionDismissed(false);
    setMentionIndex(0);
  }

  function autoResizeTextarea(target: HTMLTextAreaElement) {
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  }

  useEffect(() => {
    if (!draftSeed || !sessionId) return;
    const text = draftSeed.text.trim();
    if (!text) return;
    setDrafts((current) => ({ ...current, [sessionId]: text }));
    if (draftSeed.useWorktree === true) {
      setWorktreeModes((current) => ({
        ...current,
        [sessionId]: true,
      }));
    }
    setMentionDismissed(false);
    setMentionIndex(0);
    const textarea = textareaRef.current;
    if (textarea) {
      // Apply height after value paints.
      window.requestAnimationFrame(() => {
        autoResizeTextarea(textarea);
        textarea.focus();
        const end = text.length;
        textarea.setSelectionRange(end, end);
      });
    }
    onDraftSeedApplied?.();
  }, [draftSeed, sessionId, onDraftSeedApplied]);

  function selectMention(agent: AgentSummary) {
    setDraft(`@${agentMentionLabel(agent)} `);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!sessionId || running || !prompt) return;
    setDrafts((current) => ({ ...current, [sessionId]: "" }));
    if (textareaRef.current) {
      textareaRef.current.style.height = "";
    }
    await onSend(prompt, useWorktree);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % mentionSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (current) => (current - 1 + mentionSuggestions.length) % mentionSuggestions.length
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectMention(mentionSuggestions[mentionIndex] || mentionSuggestions[0]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form className="react-composer" onSubmit={submit}>
      <div className="react-composer-tools">
        <div className="react-composer-tools-left">
          <label className="react-worktree-toggle" title="在隔离 worktree 中运行，可安全改代码">
            <input
              type="checkbox"
              checked={useWorktree}
              disabled={!sessionId || running}
              onChange={(event) => {
                if (!sessionId) return;
                const checked = event.target.checked;
                setWorktreeModes((current) => ({ ...current, [sessionId]: checked }));
              }}
            />
            <span className="react-worktree-badge" aria-hidden="true">
              WT
            </span>
            <span>隔离改代码</span>
          </label>
        </div>
        <span className="react-composer-hint">
          {running
            ? "Agent 正在运行"
            : explicitAgent
              ? `本条将发给 ${explicitAgent.label}`
              : useWorktree
                ? "将在隔离 worktree 中运行"
                : targetAgent
                  ? `发给 ${targetAgent.label} · Enter 发送`
                  : "只读讨论 · Enter 发送"}
        </span>
      </div>

      <div className="react-composer-row">
        {mentionSuggestions.length > 0 ? (
          <div className="react-mention-menu" role="listbox" aria-label="选择消息目标 Agent">
            <span className="react-mention-header">临时指定本条消息目标</span>
            {mentionSuggestions.map((agent, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                data-active={index === mentionIndex || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMention(agent)}
                key={agent.id}
              >
                <AgentAvatar agentId={agent.id} label={agent.label} compact />
                <div className="react-mention-info">
                  <strong>{agent.label}</strong>
                  <small>@{agentMentionLabel(agent)}</small>
                </div>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          aria-label="消息"
          placeholder={sessionId ? "描述任务，或用 @ 指定 Agent…" : "请先选择一个对话"}
          rows={1}
          value={draft}
          disabled={!sessionId}
          onChange={(event) => {
            setDraft(event.target.value);
            autoResizeTextarea(event.target);
          }}
          onKeyDown={handleKeyDown}
        />

        {running ? (
          <button className="react-stop-button" type="button" onClick={onStop}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            停止
          </button>
        ) : (
          <button
            className="react-send-button"
            type="submit"
            disabled={!sessionId || !draft.trim() || !targetAgent}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            发送
          </button>
        )}
      </div>
    </form>
  );
}
