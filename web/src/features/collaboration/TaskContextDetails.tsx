import type { TaskContext, RecoveryPacket } from "../../../../src/shared/task-context";

function Items({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div>
      <strong>{label}</strong>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function TaskContextDetails({
  task,
  recovery = [],
}: {
  task?: TaskContext | null;
  recovery?: RecoveryPacket[];
}) {
  return (
    <div className="react-task-context">
      {task ? (
        <>
          <details>
            <summary>
              需求与计划 <small>版本 {task.version}</small>
            </summary>
            <strong>当前有效目标</strong>
            <p>{task.currentGoal?.text || task.originalGoal || "尚未记录"}</p>
            <Items label="用户补充" items={task.userUpdates.map((update) => update.text)} />
            {task.requirements ? (
              <>
                <strong>需求理解</strong>
                <p>{task.requirements.summary}</p>
                <Items label="约束" items={task.requirements.constraints} />
                <Items label="不做的内容" items={task.requirements.non_goals} />
                <Items label="验收标准" items={task.requirements.acceptance_criteria} />
              </>
            ) : (
              <p>需求基线尚未提交。</p>
            )}
            {task.plan ? (
              <>
                <strong>执行计划</strong>
                <p>{task.plan.summary}</p>
                <small>
                  {task.planApproval?.approvedPlanHash === task.plan.hash
                    ? "计划已通过证据门禁"
                    : "计划尚未获准执行"}
                </small>
                <Items label="涉及文件" items={task.plan.files} />
                <Items label="计划改动" items={task.plan.changes} />
                <Items label="验证安排" items={task.plan.tests} />
                <Items label="风险" items={task.plan.risks} />
              </>
            ) : (
              <p>执行计划尚未提交。</p>
            )}
          </details>
          <details open={Boolean(task.progress?.blockers.length)}>
            <summary>执行进度</summary>
            {task.progress ? (
              <>
                <small>Agent 报告 · 不代表最终验收</small>
                <p>{task.progress.current}</p>
                <Items
                  label="已报告完成及证据"
                  items={task.progress.completed.map(
                    (item) => `${item.item} — ${item.evidence.join("；")}`
                  )}
                />
                <Items label="剩余事项" items={task.progress.remaining} />
                <Items label="阻塞" items={task.progress.blockers} />
                <Items label="验证记录" items={task.progress.verification} />
                <strong>下一步</strong>
                <p>{task.progress.next_action}</p>
              </>
            ) : (
              <p>尚无绑定当前目标和计划的进度报告。</p>
            )}
            {task.review ? (
              <>
                <strong>最新审查</strong>
                <p>{task.review.summary}</p>
                <Items label="审查问题" items={task.review.findings} />
              </>
            ) : null}
          </details>
        </>
      ) : null}
      {recovery.length > 0 ? (
        <details>
          <summary>
            上下文续接 <small>{recovery.length} 次封存</small>
          </summary>
          {[...recovery].reverse().map((packet) => (
            <details key={packet.sealId} className="react-recovery-packet">
              <summary>
                {packet.metadata.agentId || "Agent"} · 窗口 {packet.metadata.generation ?? "未知"} ·{" "}
                {packet.restorations.length ? "已加入后续调用" : "未记录后续注入"}
              </summary>
              <p>
                {packet.metadata.partial ? "中途截断：仍需接续未完成工作。" : "回合结束后封存。"}
              </p>
              <small>
                {packet.createdAt} · {packet.metadata.reason || "原因未记录"}
              </small>
              <pre aria-label="续工包内容">{packet.content}</pre>
              {packet.restorations.map((restore) => (
                <p key={restore.invocationId}>
                  已加入调用 {restore.invocationId}，任务版本 {restore.taskVersion ?? "未记录"}。
                  <br />
                  <small>
                    记录于 {restore.createdAt}；表示输入已准备，不代表模型已理解或任务已完成。
                  </small>
                </p>
              ))}
            </details>
          ))}
        </details>
      ) : null}
    </div>
  );
}
