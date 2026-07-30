import { type FormEvent, type KeyboardEvent, useState } from "react";
import type { AgentSummary } from "../agents/types";

interface ComposerProps {
  sessionId: string | null;
  agents: AgentSummary[];
  selectedAgentId: string;
  running: boolean;
  onAgentChange(agentId: string): void;
  onSend(prompt: string, useWorktree: boolean): Promise<void>;
  onStop(): void;
}

export function Composer({
  sessionId,
  agents,
  selectedAgentId,
  running,
  onAgentChange,
  onSend,
  onStop,
}: ComposerProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [worktreeModes, setWorktreeModes] = useState<Record<string, boolean>>({});
  const draft = sessionId ? (drafts[sessionId] ?? "") : "";
  const useWorktree = sessionId ? (worktreeModes[sessionId] ?? false) : false;

  function setDraft(value: string) {
    if (!sessionId) return;
    setDrafts((current) => ({ ...current, [sessionId]: value }));
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!sessionId || running || !prompt) return;
    setDrafts((current) => ({ ...current, [sessionId]: "" }));
    await onSend(prompt, useWorktree);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form className="react-composer" onSubmit={submit}>
      <div className="react-composer-tools">
        <label>
          <span className="sr-only">选择 Agent</span>
          <select
            value={selectedAgentId}
            onChange={(event) => onAgentChange(event.target.value)}
            disabled={running || agents.length === 0}
          >
            {agents.map((agent) => (
              <option value={agent.id} key={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </label>
        <label className="react-worktree-toggle">
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
          <span>改代码</span>
        </label>
        <span>
          {running
            ? "Agent 正在运行"
            : useWorktree
              ? "将在隔离 worktree 中运行"
              : "只读讨论 · Enter 发送"}
        </span>
      </div>

      <div className="react-composer-row">
        <textarea
          aria-label="消息"
          placeholder={sessionId ? "描述任务，或用 @ 指定下一位 Agent…" : "请先选择一个对话"}
          rows={2}
          value={draft}
          disabled={!sessionId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />

        {running ? (
          <button className="react-stop-button" type="button" onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            className="react-send-button"
            type="submit"
            disabled={!sessionId || !draft.trim() || !selectedAgentId}
          >
            发送
          </button>
        )}
      </div>
    </form>
  );
}
