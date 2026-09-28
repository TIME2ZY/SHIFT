import { useState } from "react";
import type { AcceptanceCard, CollaborationChainStep, CollaborationSnapshot } from "./types";
import { TaskContextDetails } from "./TaskContextDetails";
import { DUTY_LABELS } from "../../shared/contracts/contract-fence";
import { invocationStateLabel } from "../../shared/contracts/invocation-state";

const STATUS_LABELS: Record<string, string> = {
  active: "推进中",
  waiting_human: "等待用户",
  accepted: "已验收",
  rejected: "已拒绝",
};

const BLOCKER_LABELS: Record<string, string> = {
  implementation_plan_missing: "尚未提交实现方案",
  implementation_plan_not_approved: "等待讨论席位批准方案",
  implementation_plan_artifact_missing: "方案正文缺失",
  code_review_pending: "等待代码审查",
  code_review_changes_requested: "审查要求修改",
  delivery_evidence_missing: "等待交付证据",
  ci_not_successful: "CI 尚未通过",
  final_acceptance_missing: "等待验收席位核验证据",
  final_acceptance_rejected: "最终验收已拒绝",
  final_acceptance_not_bound_to_outcome: "验收证据未绑定当前结果",
  acceptance_workspace_unavailable: "无法读取当前工作区",
  acceptance_worktree_dirty: "工作区存在未提交改动",
  acceptance_head_mismatch: "当前提交与交付证据不一致",
  invocation_failed: "上一轮执行失败，请排查原因后重试",
  invocation_aborted: "执行已被用户停止",
  handoff_rejected: "交接请求未满足门禁条件",
  provider_failed: "执行器未正常返回，请重试或换一个席位",
  "provider-failed": "执行器未正常返回，请重试或换一个席位",
  provider_unavailable: "执行器当前不可用，请确认 CLI 已登录后重试",
  "provider-unavailable": "执行器当前不可用，请确认 CLI 已登录后重试",
  provider_timeout: "执行器响应超时，请重试",
  "provider-timeout": "执行器响应超时，请重试",
};

/** Fallback for reason codes we have not mapped yet: never print the raw code. */
function blockerReasonLabel(reason: string) {
  const known = BLOCKER_LABELS[reason];
  if (known) return known;
  return "推进受阻，请展开审计页查看本次执行的完整记录。";
}

const REVIEW_MODE_LABELS: Record<string, string> = {
  same_seat: "当前席位自审",
  other_seat: "另一席位审查",
  pending: "尚未审查",
};

interface CollaborationStatusProps {
  snapshot: CollaborationSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function CollaborationStatus({ snapshot, loading, error }: CollaborationStatusProps) {
  return (
    <section className="react-collab-status" aria-label="任务卡">
      <header>
        <strong>任务</strong>
        <span data-status={snapshot?.status}>{statusLabel(snapshot)}</span>
      </header>
      {error ? (
        <p className="react-panel-error" role="status">
          任务状态暂不可用。
        </p>
      ) : null}
      {loading && !snapshot && !error ? (
        <p className="react-panel-empty">正在读取任务状态…</p>
      ) : null}
      {!loading && !error && !snapshot ? (
        <p className="react-panel-empty">发送消息后，这里会显示目标与完成证据。</p>
      ) : null}
      {snapshot ? (
        <>
          <dl className="react-task-assignment">
            <div>
              <dt>当前席位</dt>
              <dd>{seatLabel(snapshot)}</dd>
            </div>
            <div>
              <dt>职责</dt>
              <dd title={snapshot.currentSkill || undefined}>{dutyAndSkillLabel(snapshot)}</dd>
            </div>
            <div>
              <dt>审查方式</dt>
              <dd>{REVIEW_MODE_LABELS[snapshot.reviewMode] || "未知"}</dd>
            </div>
          </dl>
          {snapshot.chain && snapshot.chain.length > 0 ? (
            <ChainView chain={snapshot.chain} />
          ) : null}
          {snapshot.pendingHandoffs && snapshot.pendingHandoffs.length > 0 ? (
            <div className="react-task-pending-handoffs" role="status">
              <small>待处理交接</small>
              {snapshot.pendingHandoffs.map((h) => (
                <p key={h.handoffId}>
                  {h.sourceAgent || "当前席位"} <span aria-hidden="true">→</span>{" "}
                  {h.targetAgent || "下一席位"}
                  {h.reason ? ` (${h.reason})` : ""}
                </p>
              ))}
            </div>
          ) : null}
          {snapshot.blocker ? (
            <div
              className="react-collab-blocker"
              role="status"
              data-tone={
                snapshot.blocker.type === "execution_failed" ||
                snapshot.blocker.type === "provider_unavailable"
                  ? "danger"
                  : "warning"
              }
            >
              <small>{blockerTypeLabel(snapshot.blocker.type)}</small>
              <strong>{blockerReasonLabel(snapshot.blocker.reason)}</strong>
            </div>
          ) : null}
          <details className="react-task-goal" key={snapshot.goalOriginal}>
            <summary>
              <span className="react-task-goal-label">
                任务目标 <span>展开 / 收起</span>
              </span>
              <span className="react-task-goal-preview">
                {snapshot.goalNormalized || snapshot.goalOriginal || "目标尚未记录"}
              </span>
            </summary>
            <p>{snapshot.goalOriginal || "目标尚未记录"}</p>
          </details>
          <div className="react-task-evidence" aria-label="完成证据">
            <Evidence label="未提交" value={dirtyFilesLabel(snapshot.evidence.dirtyFileCount)} />
            <Evidence label="当前提交" value={shortSha(snapshot.evidence.headSha)} />
            <Evidence label="PR" value={snapshot.evidence.prUrl ? "已记录" : "—"} />
            <Evidence label="CI" value={ciLabel(snapshot.evidence.ciStatus)} />
          </div>
          <TaskContextDetails task={snapshot.taskContext} recovery={snapshot.recovery} />
          <details className="react-task-acceptance-details">
            <summary>验收：{acceptanceVerdictLabel(snapshot.acceptance.verdict)}</summary>
            <AcceptanceCardView card={snapshot.acceptance} />
          </details>
          <p className="react-task-next-action">
            <small>下一步</small>
            {snapshot.nextAction}
          </p>
        </>
      ) : null}
    </section>
  );
}

/** The tail of the chain is what the reader acts on; the head is history. */
const CHAIN_TAIL = 4;

function ChainView({ chain }: { chain: CollaborationChainStep[] }) {
  const [showAll, setShowAll] = useState(false);
  const hidden = Math.max(0, chain.length - CHAIN_TAIL);
  const steps = showAll ? chain : chain.slice(hidden);

  const counts = chain.reduce<Record<string, number>>((acc, step) => {
    const label = invocationStateLabel(step.status);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");

  return (
    <div className="react-task-chain" aria-label="协作链">
      <header className="react-task-chain-head">
        <small>协作链路</small>
        <span>
          {chain.length} 跳 · {summary}
        </span>
      </header>
      <ol className="react-task-chain-steps">
        {steps.map((step, idx) => {
          const absolute = showAll ? idx : hidden + idx;
          return (
            <li key={step.invocationId || `${step.seatId}-${absolute}`} data-status={step.status}>
              <i className="react-task-chain-dot" aria-hidden="true" />
              <span className="react-task-chain-who">
                {step.label || step.providerId || step.seatId}
                {step.duty ? ` (${DUTY_LABELS[step.duty] || step.duty})` : ""}
              </span>
              <em>{invocationStateLabel(step.status)}</em>
            </li>
          );
        })}
      </ol>
      {hidden > 0 || showAll ? (
        <button
          type="button"
          className="react-task-chain-toggle"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? "只看最近几跳" : `展开更早的 ${hidden} 跳`}
        </button>
      ) : null}
    </div>
  );
}

function AcceptanceCardView({ card }: { card: AcceptanceCard }) {
  return (
    <section className="react-acceptance-card" aria-label="验收卡" data-verdict={card.verdict}>
      <header>
        <strong>验收</strong>
        <span>{acceptanceVerdictLabel(card.verdict)}</span>
      </header>
      <dl>
        <AcceptanceFact label="目标" value={shortHash(card.goalHash)} />
        <AcceptanceFact label="方案" value={shortHash(card.planHash)} />
        <AcceptanceFact label="分支" value={card.branch || "未知"} />
        <AcceptanceFact
          label="Commit"
          value={card.commitSha ? shortSha(card.commitSha) : "未核验"}
        />
        <AcceptanceFact label="PR" value={card.prUrl ? "已核验" : "未核验"} />
        <AcceptanceFact label="CI" value={ciLabel(card.ciStatus)} />
        <AcceptanceFact label="审查" value={REVIEW_MODE_LABELS[card.reviewMode] || "未知"} />
        <AcceptanceFact label="结论" value={reviewVerdictLabel(card.reviewVerdict)} />
      </dl>
      {card.reason && card.verdict !== "accepted" ? (
        <p className="react-acceptance-reason">{acceptanceReasonLabel(card.reason)}</p>
      ) : null}
    </section>
  );
}

function AcceptanceFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

function Evidence({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function statusLabel(snapshot: CollaborationSnapshot | null) {
  if (!snapshot) return "未开始";
  return STATUS_LABELS[snapshot.status] || "未知";
}

function seatLabel(snapshot: CollaborationSnapshot) {
  const seat = snapshot.currentSeat;
  return seat?.label || seat?.providerId || seat?.seatId || "尚未分配";
}

function dutyAndSkillLabel(snapshot: CollaborationSnapshot) {
  if (!snapshot.currentDuty && !snapshot.currentSkill) return "尚未分配";
  const duty = snapshot.currentDuty ? DUTY_LABELS[snapshot.currentDuty] || "未知职责" : "未知职责";
  return snapshot.currentSkill ? `${duty} · ${snapshot.currentSkill}` : duty;
}

function blockerTypeLabel(type: string) {
  const labels: Record<string, string> = {
    waiting_human: "等待用户",
    waiting_approval: "等待方案门禁",
    missing_evidence: "缺少证据",
    provider_unavailable: "执行器不可用",
    execution_failed: "执行失败",
  };
  return labels[type] || "未知";
}

function dirtyFilesLabel(count: number | null) {
  if (count === null) return "—";
  return count === 0 ? "0" : String(count);
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 7) : "—";
}

function ciLabel(status: string | null) {
  if (!status) return "—";
  const labels: Record<string, string> = {
    success: "通过",
    failure: "失败",
    pending: "进行中",
    unknown: "未知",
  };
  return labels[status] || "未知";
}

function shortHash(value: string | null) {
  return value ? value.slice(0, 12) : "未知";
}

function acceptanceVerdictLabel(verdict: AcceptanceCard["verdict"]) {
  const labels: Record<AcceptanceCard["verdict"], string> = {
    accepted: "已通过",
    rejected: "已拒绝",
    incomplete: "未完成",
  };
  return labels[verdict];
}

function reviewVerdictLabel(verdict: AcceptanceCard["reviewVerdict"]) {
  const labels: Record<AcceptanceCard["reviewVerdict"], string> = {
    approved: "通过",
    changes_requested: "需修改",
    unknown: "未知",
  };
  return labels[verdict];
}

function acceptanceReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    accept_duty_rejected: "验收席位已拒绝本次交付。",
    user_goal_missing: "缺少可核验的用户目标。",
    solution_baseline_missing: "缺少与目标绑定的已批准方案。",
    implementation_plan_not_approved: "实现方案尚未批准。",
    code_review_not_approved: "代码审查尚未通过。",
    code_review_artifact_missing: "缺少代码审查证据。",
    delivery_not_bound_to_review: "交付未绑定到已通过的审查。",
    delivery_commit_missing: "缺少可核验的提交。",
    acceptance_workspace_unavailable: "无法读取当前工作区，请恢复访问后重新核验。",
    acceptance_worktree_dirty: "工作区存在未提交改动，请重新核验交付证据。",
    acceptance_head_mismatch: "当前 HEAD 与已核验提交不一致，请重新审查并核验交付。",
    delivery_pr_missing: "缺少可核验的 PR。",
    delivery_artifact_missing: "交付证据不完整。",
    ci_not_successful: "CI 尚未通过。",
    final_acceptance_not_bound_to_outcome: "Agent 验收证据未与当前目标、方案和提交绑定。",
  };
  return labels[reason] || "验收未通过，完整原因见审计页。";
}
