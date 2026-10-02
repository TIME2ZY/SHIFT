import { useEffect, useState } from "react";
import { useTaskActions, useTaskQuery } from "./queries";
import type { DelegationContract, DelegationState } from "./types";

export const DELEGATION_LABELS: Record<DelegationState, string> = {
  draft: "委托草稿",
  queued: "排队中",
  running: "执行中",
  cancelling: "正在停止",
  completed: "已交付",
  failed: "未完成",
  cancelled: "已取消",
};
export function TaskConsole({
  sessionId,
  onRelatedTask,
}: {
  sessionId: string | null;
  onRelatedTask: (source: string) => void;
}) {
  const query = useTaskQuery(sessionId);
  const actions = useTaskActions();
  const task = query.data?.task;
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<DelegationContract | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(task?.contract ?? null);
    setRequest(task?.contract?.goal ?? "");
  }, [task?.threadId, task?.version]);
  if (!sessionId)
    return (
      <section className="delegation-console">
        <h2>把目标委托给 SHIFT</h2>
        <p>新建委托，主 Agent 整理需求，平台选择执行团队。</p>
      </section>
    );
  if (!task)
    return (
      <section className="delegation-console">
        <p>{query.isPending ? "读取任务…" : "历史会话可在执行细节中回看。"}</p>
      </section>
    );
  const editable = task.delegationState === "draft";
  const pending = actions.isPending;
  const preparing = query.data?.preparingThreadId === task.threadId;
  const updateList = (key: "deliverables" | "acceptanceCriteria", value: string) => {
    if (draft) setDraft({ ...draft, [key]: value.split("\n") });
  };
  return (
    <section className="delegation-console" aria-label="任务委托">
      <header>
        <strong>{DELEGATION_LABELS[task.delegationState]}</strong>
        <span>{task.queueSeq ? " · 排队序号 " + task.queueSeq : ""}</span>
      </header>
      {query.data?.recoveryBlocked && (
        <p role="alert">上次运行中断，正在等待遗留进程核验；排队任务保留。</p>
      )}
      {editable ? (
        <>
          <label>
            目标与补充材料
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="描述希望得到的结果、约束和可用材料…"
            />
          </label>
          <button
            disabled={pending || !request.trim() || query.data?.busy}
            onClick={() =>
              actions.mutate({ action: "prepare", id: task.threadId, prompt: request })
            }
          >
            主 Agent 整理草稿
          </button>
          {query.data?.busy && (
            <p>
              {preparing
                ? "主 Agent 正在整理草稿。"
                : "平台正在执行其他任务；本草稿可编辑和提交排队。"}
            </p>
          )}
          {preparing && (
            <button
              disabled={pending}
              onClick={() => actions.mutate({ action: "cancel", id: task.threadId })}
            >
              取消委托
            </button>
          )}
          {draft && (
            <fieldset disabled={pending || preparing}>
              <legend>提交前确认委托范围</legend>
              <label>
                收敛目标
                <textarea
                  value={draft.goal}
                  onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
                />
              </label>
              <label>
                交付物（每行一项）
                <textarea
                  value={draft.deliverables.join("\n")}
                  onChange={(event) => updateList("deliverables", event.target.value)}
                />
              </label>
              <label>
                完成条件（每行一项）
                <textarea
                  value={draft.acceptanceCriteria.join("\n")}
                  onChange={(event) => updateList("acceptanceCriteria", event.target.value)}
                />
              </label>
              <ol>
                {draft.subtasks.map((item, index) => (
                  <li key={item.id}>
                    <label>
                      分任务 {index + 1}
                      <input
                        value={item.title}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            subtasks: draft.subtasks.map((entry) =>
                              entry.id === item.id ? { ...entry, title: event.target.value } : entry
                            ),
                          })
                        }
                      />
                    </label>
                    <textarea
                      aria-label={"分任务 " + (index + 1) + " 说明"}
                      value={item.description}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          subtasks: draft.subtasks.map((entry) =>
                            entry.id === item.id
                              ? { ...entry, description: event.target.value }
                              : entry
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      disabled={draft.subtasks.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          subtasks: draft.subtasks.filter((entry) => entry.id !== item.id),
                        })
                      }
                    >
                      移除分任务
                    </button>
                  </li>
                ))}
              </ol>
              <button
                onClick={() =>
                  setDraft({
                    ...draft,
                    subtasks: [
                      ...draft.subtasks,
                      {
                        id: "step-" + crypto.randomUUID(),
                        title: "新分任务",
                        description: "描述范围和完成条件",
                      },
                    ],
                  })
                }
              >
                添加分任务
              </button>
              <button
                onClick={() =>
                  actions.mutate({
                    action: "save",
                    id: task.threadId,
                    contract: draft,
                    expectedRevision: task.version,
                  })
                }
              >
                保存草稿
              </button>
              <button
                disabled={preparing}
                onClick={async () => {
                  setSubmissionError(null);
                  try {
                    const saved = await actions.mutateAsync({
                      action: "save",
                      id: task.threadId,
                      contract: draft,
                      expectedRevision: task.version,
                    });
                    if (saved.task)
                      await actions.mutateAsync({
                        action: "submit",
                        id: task.threadId,
                        expectedRevision: saved.task.version,
                      });
                  } catch (error) {
                    setSubmissionError(
                      error instanceof Error ? error.message : "提交失败，请重试。"
                    );
                  }
                }}
              >
                提交委托
              </button>
              <p>提交后固定目标与范围；执行由平台推进，需求变化建立关联新委托。</p>
            </fieldset>
          )}
        </>
      ) : (
        <>
          <h2>{task.contract?.goal}</h2>
          <ol>
            {task.contract?.subtasks.map((item) => (
              <li key={item.id}>
                <strong>{item.title}</strong>
                <span>
                  {" "}
                  ·{" "}
                  {
                    {
                      accepted: "验收通过",
                      reported_complete: "Agent 报告完成",
                      in_progress: "Agent 正在处理",
                      pending: "待报告",
                    }[
                      task.subtaskProgress?.items.find((entry) => entry.id === item.id)?.state ||
                        "pending"
                    ]
                  }
                </span>
                <p>{item.description}</p>
              </li>
            ))}
          </ol>
          {task.subtaskProgress?.blockers.length ? (
            <p role="status">Agent 报告阻塞：{task.subtaskProgress.blockers.join("；")}</p>
          ) : null}
          <h3>交付物</h3>
          <ul>
            {task.contract?.deliverables.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
          <h3>完成条件</h3>
          <ul>
            {task.contract?.acceptanceCriteria.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
          <p>
            团队：
            {task.team?.members
              .map(
                (member) =>
                  member.label + (member.availabilityStatus === "unknown" ? "（可用性待验证）" : "")
              )
              .join("、")}
          </p>
          {task.team?.reviewMode === "solo_fallback" && (
            <p>当前由一个 Agent 承担各职责，审查采用同席位模式。</p>
          )}
          <p>修复轮次：{task.repairCount}</p>
          {["queued", "running", "cancelling"].includes(task.delegationState) && (
            <button
              disabled={pending || task.delegationState === "cancelling"}
              onClick={() => actions.mutate({ action: "cancel", id: task.threadId })}
            >
              取消委托
            </button>
          )}
          {["completed", "failed", "cancelled"].includes(task.delegationState) && (
            <button onClick={() => onRelatedTask(task.threadId)}>建立关联新委托</button>
          )}
          {task.result && (
            <div>
              <h3>交付结果</h3>
              <p className="delegation-result">{task.result.summary}</p>
              {task.result.workspaceDir && (
                <p>
                  成果目录：<code>{task.result.workspaceDir}</code>
                </p>
              )}
              {task.result.delivery?.commitSha && <p>Commit：{task.result.delivery.commitSha}</p>}
              {task.result.delivery?.prUrl && (
                <a href={task.result.delivery.prUrl} target="_blank" rel="noreferrer">
                  查看交付 PR
                </a>
              )}
              <p>CI：{task.result.delivery?.ciStatus || "unknown"}</p>
            </div>
          )}
        </>
      )}
      {task.delegationReason && (
        <p role="status">
          {{
            acceptance_incomplete: "完成证据尚不齐全，成果已保留。可建立关联新委托补充要求。",
            deadline_exceeded: "执行超过平台期限，成果已保留。",
            application_interrupted: "应用中断，先前执行已收口。可建立关联委托继续。",
            user_cancelled: "委托已取消，已有成果和记录保留。",
          }[task.delegationReason] || task.delegationReason}
        </p>
      )}
      {actions.error && <p role="alert">{actions.error.message}</p>}
      {submissionError && !actions.error && <p role="alert">{submissionError}</p>}
    </section>
  );
}
