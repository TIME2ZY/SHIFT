import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  type InvocationEvent,
  type InvocationSummary,
  type RecallHit,
  type RecallLayer,
  useInvocationQuery,
  useInvocationsQuery,
  useRecallSearchQuery,
} from "./queries";

interface RecallPanelProps {
  sessionId: string | null;
}

const LAYER_LABELS: Record<RecallLayer, string> = {
  memory: "记忆",
  message: "消息",
  evidence: "证据",
  "project-doc": "项目文档",
};

function stateLabel(state: string | null | undefined): string {
  if (!state) return "运行中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "失败";
  if (state === "aborted") return "已停止";
  return state;
}

function formatTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function eventBodyText(event: InvocationEvent): string {
  const payload = event.payload || {};
  const preferred = [
    payload.text,
    payload.content,
    payload.message,
    payload.output,
    payload.detail,
    payload.toolName,
    payload.name,
  ].find((value) => typeof value === "string" && value.trim());

  if (typeof preferred === "string") return preferred;
  if (Object.keys(payload).length === 0) return "";

  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function InvocationEvents({
  sessionId,
  invocationId,
}: {
  sessionId: string;
  invocationId: string;
}) {
  const invocation = useInvocationQuery(sessionId, invocationId, true);

  if (invocation.isPending) {
    return <p className="react-recall-inline-state">正在读取调用轨迹…</p>;
  }
  if (invocation.error) {
    return <p className="react-panel-error">{invocation.error.message}</p>;
  }

  return (
    <div className="react-invocation-events">
      {invocation.data?.events.map((event) => {
        const body = eventBodyText(event);
        const eventNo = event.eventNo ?? event.sequenceNo;
        return (
          <article key={`${eventNo ?? "event"}-${event.kind}`}>
            <header>
              <code>#{eventNo ?? "?"}</code>
              <strong>{event.kind}</strong>
              <time>{formatTime(event.ts || event.createdAt)}</time>
            </header>
            {body ? <pre>{body}</pre> : null}
          </article>
        );
      })}
      {invocation.data && invocation.data.total > invocation.data.events.length ? (
        <p className="react-recall-inline-state">
          当前展示前 {invocation.data.events.length} / {invocation.data.total} 个事件。
        </p>
      ) : null}
    </div>
  );
}

function InvocationList({
  sessionId,
  invocations,
}: {
  sessionId: string;
  invocations: InvocationSummary[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="react-invocation-list">
      {invocations.map((invocation) => {
        const open = openId === invocation.invocationId;
        return (
          <article key={invocation.invocationId} data-open={open || undefined}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : invocation.invocationId)}
            >
              <span>
                <strong>{invocation.agent || "Agent"}</strong>
                <small data-state={invocation.state || "active"}>
                  {stateLabel(invocation.state)}
                </small>
              </span>
              <span>
                <small>{invocation.eventCount || 0} 个事件</small>
                <time>{formatTime(invocation.startedAt)}</time>
              </span>
            </button>
            {open ? (
              <InvocationEvents sessionId={sessionId} invocationId={invocation.invocationId} />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function RecallResults({ sessionId, hits }: { sessionId: string; hits: RecallHit[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="react-recall-results">
      {hits.map((hit, index) => {
        const key = `${hit.sourceId || hit.invocationId || "hit"}-${hit.eventNo ?? index}`;
        const canExpand = Boolean(hit.invocationId);
        const open = openKey === key;
        return (
          <article key={key} data-layer={hit.layer}>
            <header>
              <span>{LAYER_LABELS[hit.layer] || hit.layer}</span>
              <small>{hit.memoryTopic || hit.kind || hit.sourceKind || "记录"}</small>
              <time>{formatTime(hit.ts)}</time>
            </header>
            <p>{hit.snippet || hit.content || "无可显示内容。"}</p>
            {canExpand ? (
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenKey(open ? null : key)}
              >
                {open ? "收起调用轨迹" : "查看调用轨迹"}
              </button>
            ) : null}
            {open && hit.invocationId ? (
              <InvocationEvents sessionId={sessionId} invocationId={hit.invocationId} />
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

export function RecallPanel({ sessionId }: RecallPanelProps) {
  const [mode, setMode] = useState<"history" | "search">("history");
  const [input, setInput] = useState("");
  const [searchText, setSearchText] = useState("");
  const invocations = useInvocationsQuery(sessionId, mode === "history");
  const search = useRecallSearchQuery(sessionId, searchText, mode === "search");

  useEffect(() => {
    setInput("");
    setSearchText("");
  }, [sessionId]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    setSearchText(next);
  }

  if (!sessionId) {
    return <p className="react-panel-empty">请先选择对话。</p>;
  }

  return (
    <section className="react-recall-panel" aria-label="Recall">
      <p className="react-panel-kicker">SESSION RECALL</p>
      <div className="react-recall-modes" role="tablist" aria-label="Recall 查看方式">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "history"}
          data-active={mode === "history" || undefined}
          onClick={() => setMode("history")}
        >
          调用历史
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "search"}
          data-active={mode === "search" || undefined}
          onClick={() => setMode("search")}
        >
          搜索证据
        </button>
      </div>

      {mode === "history" ? (
        <>
          {invocations.isPending ? <p className="react-panel-empty">正在读取调用历史…</p> : null}
          {invocations.error ? (
            <p className="react-panel-error">{invocations.error.message}</p>
          ) : null}
          {invocations.data?.length === 0 ? (
            <p className="react-panel-empty">当前对话还没有调用记录。</p>
          ) : null}
          {invocations.data ? (
            <InvocationList sessionId={sessionId} invocations={invocations.data} />
          ) : null}
        </>
      ) : (
        <>
          <form className="react-recall-search" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="react-recall-query">
              搜索当前对话
            </label>
            <input
              id="react-recall-query"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="搜索记忆、消息和证据…"
            />
            <button type="submit" disabled={!input.trim() || search.isFetching}>
              {search.isFetching ? "搜索中" : "搜索"}
            </button>
          </form>
          {!searchText ? (
            <p className="react-panel-empty">输入关键词，查找当前对话的持久记忆与运行证据。</p>
          ) : null}
          {search.error ? <p className="react-panel-error">{search.error.message}</p> : null}
          {search.data ? (
            <>
              <div className="react-recall-summary">
                <span>{search.data.hits.length} 条结果</span>
                {Object.entries(search.data.layers).map(([layer, count]) =>
                  count ? (
                    <small key={layer}>
                      {LAYER_LABELS[layer as RecallLayer] || layer} {count}
                    </small>
                  ) : null
                )}
              </div>
              {search.data.hits.length ? (
                <RecallResults sessionId={sessionId} hits={search.data.hits} />
              ) : (
                <p className="react-panel-empty">没有找到匹配内容，请调整关键词。</p>
              )}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
