import { useState } from "react";
import type { AcceptanceCard, CollaborationSnapshot } from "./types";

const STATUS_LABELS: Record<string, string> = {
  active: "推进中",
  waiting_human: "等待用户",
  accepted: "已验收",
  rejected: "已拒绝",
};

const DUTY_LABELS: Record<string, string> = {
  discuss: "讨论",
  plan: "规划",
  implement: "实现",
  fix: "修复",
  review: "审查",
  deliver: "交付",
  accept: "验收",
  recall: "回忆",
};

const BLOCKER_LABELS: Record<string, string> = {
  implementation_plan_missing: "尚未提交实现方案",
  implementation_plan_not_approved: "等待批准实现方案",
  implementation_plan_artifact_missing: "方案正文缺失",
  code_review_pending: "等待代码审查",
  delivery_evidence_missing: "等待交付证据",
  ci_not_successful: "CI 尚未通过",
  final_acceptance_missing: "等待最终验收",
  human_acceptance_required: "等待用户对照目标验收",
  final_acceptance_rejected: "最终验收已拒绝",
  human_input_required: "等待用户输入",
  acceptance_workspace_unavailable: "无法读取当前工作区",
  acceptance_worktree_dirty: "工作区存在未提交改动",
  acceptance_head_mismatch: "当前提交与交付证据不一致",
};

const REVIEW_MODE_LABELS: Record<string, string> = {
  same_seat: "当前席位自审",
  other_seat: "另一席位审查",
  pending: "尚未审查",
};

interface CollaborationStatusProps {
  snapshot: CollaborationSnapshot | null;
  loading: boolean;
  error: Error | null;
  onAcceptanceDecision?(
    verdict: "accepted" | "rejected" | "incomplete",
    note?: string
  ): Promise<unknown>;
}

export function CollaborationStatus({
  snapshot,
  loading,
  error,
  onAcceptanceDecision,
}: CollaborationStatusProps) {
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
          <div className="react-task-goal">
            <small>目标</small>
            <strong>{snapshot.goalOriginal || "目标尚未记录"}</strong>
            {snapshot.goalNormalized && snapshot.goalNormalized !== snapshot.goalOriginal ? (
              <p>{snapshot.goalNormalized}</p>
            ) : null}
          </div>
          <dl className="react-task-assignment">
            <div>
              <dt>当前席位</dt>
              <dd>{seatLabel(snapshot)}</dd>
            </div>
            <div>
              <dt>职责 / Skill</dt>
              <dd title={snapshot.currentSkill || undefined}>{dutyAndSkillLabel(snapshot)}</dd>
            </div>
            <div>
              <dt>审查方式</dt>
              <dd>{REVIEW_MODE_LABELS[snapshot.reviewMode] || snapshot.reviewMode}</dd>
            </div>
          </dl>
          {snapshot.blocker ? (
            <div className="react-collab-blocker" role="status">
              <small>{blockerTypeLabel(snapshot.blocker.type)}</small>
              <strong>{BLOCKER_LABELS[snapshot.blocker.reason] || snapshot.blocker.reason}</strong>
            </div>
          ) : null}
          <div className="react-task-evidence" aria-label="完成证据">
            <Evidence label="脏文件" value={dirtyFilesLabel(snapshot.evidence.dirtyFileCount)} />
            <Evidence label="HEAD" value={shortSha(snapshot.evidence.headSha)} />
            <Evidence label="PR" value={snapshot.evidence.prUrl ? "已记录" : "—"} />
            <Evidence label="CI" value={ciLabel(snapshot.evidence.ciStatus)} />
          </div>
          <AcceptanceCardView card={snapshot.acceptance} onDecision={onAcceptanceDecision} />
          <p className="react-task-next-action">
            <small>下一步</small>
            {snapshot.nextAction}
          </p>
        </>
      ) : null}
    </section>
  );
}

function AcceptanceCardView({
  card,
  onDecision,
}: {
  card: AcceptanceCard;
  onDecision?: CollaborationStatusProps["onAcceptanceDecision"];
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  async function decide(verdict: "accepted" | "rejected" | "incomplete") {
    if (!onDecision) return;
    setSubmitting(true);
    setDecisionError(null);
    try {
      await onDecision(verdict, note.trim() || undefined);
      setOpen(false);
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : "验收决定保存失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="react-acceptance-card" aria-label="验收卡" data-verdict={card.verdict}>
      <header>
        <strong>验收</strong>
        <span>{acceptanceVerdictLabel(card.verdict)}</span>
      </header>
      <dl>
        <AcceptanceFact label="目标" value={shortHash(card.goalHash)} />
        <AcceptanceFact label="方案" value={shortHash(card.planHash)} />
        <AcceptanceFact label="分支" value={card.branch || "unknown"} />
        <AcceptanceFact
          label="Commit"
          value={card.commitSha ? shortSha(card.commitSha) : "unknown"}
        />
        <AcceptanceFact label="PR" value={card.prUrl ? "已核验" : "unknown"} />
        <AcceptanceFact
          label="CI"
          value={card.ciStatus === "unknown" ? "unknown" : ciLabel(card.ciStatus)}
        />
        <AcceptanceFact
          label="审查"
          value={REVIEW_MODE_LABELS[card.reviewMode] || card.reviewMode}
        />
        <AcceptanceFact label="结论" value={reviewVerdictLabel(card.reviewVerdict)} />
      </dl>
      {card.reason && card.verdict !== "accepted" ? (
        <p className="react-acceptance-reason">{acceptanceReasonLabel(card.reason)}</p>
      ) : null}
      {card.verdict !== "accepted" && onDecision ? (
        <button className="react-acceptance-open" type="button" onClick={() => setOpen(true)}>
          对照目标验收
        </button>
      ) : null}
      {open ? (
        <div className="react-acceptance-actions">
          <label>
            <span>验收说明（可选）</span>
            <textarea value={note} rows={3} onChange={(event) => setNote(event.target.value)} />
          </label>
          {decisionError ? <p role="alert">{decisionError}</p> : null}
          <div>
            <button type="button" disabled={submitting} onClick={() => void decide("incomplete")}>
              暂不验收
            </button>
            <button type="button" disabled={submitting} onClick={() => void decide("rejected")}>
              拒绝交付
            </button>
            <button type="button" disabled={submitting} onClick={() => void decide("accepted")}>
              确认验收
            </button>
          </div>
        </div>
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
  return STATUS_LABELS[snapshot.status] || snapshot.status;
}

function seatLabel(snapshot: CollaborationSnapshot) {
  const seat = snapshot.currentSeat;
  return seat?.label || seat?.providerId || seat?.seatId || "尚未分配";
}

function dutyAndSkillLabel(snapshot: CollaborationSnapshot) {
  if (!snapshot.currentDuty && !snapshot.currentSkill) return "尚未分配";
  const duty = snapshot.currentDuty
    ? DUTY_LABELS[snapshot.currentDuty] || snapshot.currentDuty
    : "未知职责";
  return snapshot.currentSkill ? `${duty} · ${snapshot.currentSkill}` : duty;
}

function blockerTypeLabel(type: string) {
  const labels: Record<string, string> = {
    waiting_human: "等待用户",
    waiting_approval: "等待批准",
    missing_evidence: "缺少证据",
    provider_unavailable: "执行器不可用",
    execution_failed: "执行失败",
  };
  return labels[type] || type;
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
  return labels[status] || status;
}

function shortHash(value: string | null) {
  return value ? value.slice(0, 12) : "unknown";
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
    unknown: "unknown",
  };
  return labels[verdict];
}

function acceptanceReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    human_acceptance_required: "等待用户对照目标作出最终决定。",
    human_rejected: "用户已拒绝本次交付。",
    human_marked_incomplete: "用户认为当前交付尚未完成。",
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
  return labels[reason] || reason;
}
