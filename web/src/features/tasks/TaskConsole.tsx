import { useEffect, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { MaterialsEditor } from "./MaterialsEditor";
import { ReportArtifact } from "./ReportArtifact";
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
  taskId,
  onObserve,
  onRelatedTask,
}: {
  taskId: string | null;
  onObserve?: (threadId: string) => void;
  onRelatedTask: (source: string) => void;
}) {
  const query = useTaskQuery(taskId);
  const actions = useTaskActions();
  const inputPending = useIsMutating({ mutationKey: ["task-inputs", taskId] }) > 0;
  const task = query.data?.task;
  const [request, setRequest] = useState("");
  const [draft, setDraft] = useState<DelegationContract | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(task?.contract ?? null);
  }, [task?.id, task?.revision]);
  useEffect(() => {
    setRequest(task?.contract?.goal ?? "");
  }, [task?.id]);
  if (!taskId)
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
  const editable = task.state === "draft";
  const pending = actions.isPending || inputPending;
  const preparing = query.data?.preparingTaskId === task.id;
  const updateList = (key: "deliverables" | "acceptanceCriteria", value: string) => {
    if (draft) setDraft({ ...draft, [key]: value.split("\n") });
  };
  return (
    <section className="delegation-console" aria-label="任务委托">
      <header>
        <strong>{DELEGATION_LABELS[task.state]}</strong>
        <span>{task.queueSeq ? " · 排队序号 " + task.queueSeq : ""}</span>
      </header>
      {query.data?.recoveryBlocked && (
        <p role="alert">上次运行中断，正在等待遗留进程核验；排队任务保留。</p>
      )}
      <MaterialsEditor key={task.id} task={task} disabled={pending || preparing} />
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
            onClick={() => actions.mutate({ action: "prepare", id: task.id, prompt: request })}
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
              onClick={() => actions.mutate({ action: "cancel", id: task.id })}
            >
              取消委托
            </button>
          )}
          {task.preparationMessage && (
            <p className="delegation-result" role="status">
              {task.preparationMessage.content
                .replace(/```delegation_plan\s*\n[\s\S]*?\n```/g, "")
                .trim() || "主 Agent 已生成计划，可在下方编辑。"}
            </p>
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
                    <p>
                      节点 ID：{item.id} · 流程：{item.workflowId} · 能力：
                      {item.capabilities.join("、")}
                    </p>
                    <label>
                      依赖节点（逗号分隔 ID）
                      <input
                        value={item.dependsOn.join(",")}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            subtasks: draft.subtasks.map((entry) =>
                              entry.id === item.id
                                ? {
                                    ...entry,
                                    dependsOn: event.target.value
                                      .split(",")
                                      .map((id) => id.trim())
                                      .filter(Boolean),
                                  }
                                : entry
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      分任务交付物（每行一项）
                      <textarea
                        value={item.deliverables.join("\n")}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            subtasks: draft.subtasks.map((entry) =>
                              entry.id === item.id
                                ? { ...entry, deliverables: event.target.value.split("\n") }
                                : entry
                            ),
                          })
                        }
                      />
                    </label>
                    <label>
                      分任务完成条件（每行一项）
                      <textarea
                        value={item.acceptanceCriteria.join("\n")}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            subtasks: draft.subtasks.map((entry) =>
                              entry.id === item.id
                                ? { ...entry, acceptanceCriteria: event.target.value.split("\n") }
                                : entry
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={draft.subtasks.length === 1}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          subtasks: draft.subtasks
                            .filter((entry) => entry.id !== item.id)
                            .map((entry) => ({
                              ...entry,
                              dependsOn: entry.dependsOn.filter((id) => id !== item.id),
                            })),
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
                        workflowId: "software_delivery",
                        capabilities: ["software"],
                        dependsOn: [],
                        deliverables: [...draft.deliverables],
                        acceptanceCriteria: [...draft.acceptanceCriteria],
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
                    id: task.id,
                    contract: draft,
                    expectedRevision: task.revision,
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
                      id: task.id,
                      contract: draft,
                      expectedRevision: task.revision,
                    });
                    if (saved.task)
                      await actions.mutateAsync({
                        action: "submit",
                        id: task.id,
                        expectedRevision: saved.task.revision,
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
                  {" · " +
                    {
                      pending: "待领取",
                      running: "团队执行中",
                      completed: "验收通过",
                      failed: "失败",
                      cancelled: "取消",
                    }[task.nodes.find((entry) => entry.id === item.id)?.state || "pending"]}
                </span>
                <p>{item.description}</p>
              </li>
            ))}
          </ol>
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
          <h3>团队运行</h3>
          {task.nodes.map((node) => (
            <p key={node.id}>
              {node.title}：
              {node.team.members
                .map(
                  (member) =>
                    member.label +
                    (member.availabilityStatus === "unknown" ? "（可用性待验证）" : "")
                )
                .join("、")}
              {Object.values(node.team.bindings).some(
                (binding) => binding.routingReason === "solo_fallback"
              )
                ? " · 同席位审查"
                : ""}
            </p>
          ))}
          <ol>
            {task.runs.map((run) => (
              <li key={run.id}>
                {run.nodeId} · 第 {run.attempt} 次尝试 · {run.state}
                {run.reason ? " · " + run.reason : ""}
                {run.unknownSideEffect ? " · 中断前副作用待核验" : ""}
                {run.threadId && (
                  <button onClick={() => onObserve?.(run.threadId!)}>查看执行记录</button>
                )}
              </li>
            ))}
          </ol>
          {task.acceptances.map((acceptance) => (
            <p key={acceptance.runId}>
              验收：{acceptance.evidenceLevel === "verified" ? "平台证据核验" : "Agent 审查"} ·{" "}
              {acceptance.criteria.join("；")}
              {acceptance.evidence.sourceChecks ? " · 原文引用已核验" : ""}
            </p>
          ))}
          {["queued", "running", "cancelling"].includes(task.state) && (
            <button
              disabled={pending || task.state === "cancelling"}
              onClick={() => actions.mutate({ action: "cancel", id: task.id })}
            >
              取消委托
            </button>
          )}
          {["completed", "failed", "cancelled"].includes(task.state) && (
            <button onClick={() => onRelatedTask(task.id)}>建立关联新委托</button>
          )}
          {task.artifacts.length > 0 && (
            <div>
              <h3>成果</h3>
              {task.artifacts.map((artifact) =>
                artifact.kind === "markdown_report" ? (
                  <ReportArtifact key={artifact.id} taskId={task.id} artifact={artifact} />
                ) : (
                  <article key={artifact.id}>
                    <p className="delegation-result">{artifact.summary}</p>
                    <p>
                      {artifact.kind}：<code>{artifact.locator}</code>
                    </p>
                    {artifact.contentHash && (
                      <p>
                        版本：<code>{artifact.contentHash}</code>
                      </p>
                    )}
                  </article>
                )
              )}
            </div>
          )}
          {task.legacySource && (
            <>
              <p>此任务来自旧版记录；执行历史与原结果保留。</p>
              {task.legacySource.result &&
                typeof task.legacySource.result === "object" &&
                "summary" in task.legacySource.result &&
                typeof task.legacySource.result.summary === "string" && (
                  <p className="delegation-result">{task.legacySource.result.summary}</p>
                )}
            </>
          )}
        </>
      )}
      {task.reason && (
        <p role="status">
          {{
            needs_input: "主 Agent 需要补充信息，请结合上方反馈继续描述目标。",
            acceptance_incomplete: "完成证据尚不齐全，成果已保留。可建立关联新委托补充要求。",
            deadline_exceeded: "执行超过平台期限，成果已保留。",
            application_interrupted: "应用中断，先前执行已收口。可建立关联委托继续。",
            user_cancelled: "委托已取消，已有成果和记录保留。",
          }[task.reason] || task.reason}
        </p>
      )}
      {actions.error && <p role="alert">{actions.error.message}</p>}
      {submissionError && !actions.error && <p role="alert">{submissionError}</p>}
    </section>
  );
}
