import type { CollaborationSnapshot } from "./types";

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
  human_input_required: "等待用户输入",
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
          <p className="react-task-next-action">
            <small>下一步</small>
            {snapshot.nextAction}
          </p>
        </>
      ) : null}
    </section>
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
