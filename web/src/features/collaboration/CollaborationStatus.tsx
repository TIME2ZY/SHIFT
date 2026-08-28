import type { CollaborationSnapshot } from "./types";

const PHASE_LABELS: Record<string, string> = {
  discuss: "讨论",
  implement: "实现",
  review: "审查",
  deliver: "交付",
  done: "完成",
};

const IMPLEMENTATION_LABELS: Record<string, string> = {
  required: "待提交方案",
  pending_approval: "待 Codex 批准",
  approved: "已批准",
};

const BLOCKER_LABELS: Record<string, string> = {
  implementation_plan_missing: "尚未提交方案",
  implementation_plan_not_approved: "等待 Codex 批准方案",
  implementation_plan_artifact_missing: "方案正文缺失",
  code_review_pending: "等待代码审查",
  delivery_evidence_missing: "等待交付证据",
  ci_not_successful: "CI 未通过",
  final_acceptance_missing: "等待最终验收",
};

interface CollaborationStatusProps {
  snapshot: CollaborationSnapshot | null;
  loading: boolean;
  error: Error | null;
}

export function CollaborationStatus({ snapshot, loading, error }: CollaborationStatusProps) {
  return (
    <section className="react-collab-status" aria-label="协作状态">
      <header>
        <strong>协作</strong>
        <span>{phaseLabel(snapshot?.phase)}</span>
      </header>
      {error ? (
        <p className="react-panel-error" role="status">
          协作状态暂不可用。
        </p>
      ) : null}
      {loading && !snapshot && !error ? (
        <p className="react-panel-empty">正在读取协作状态…</p>
      ) : null}
      {!loading && !error && !snapshot ? <p className="react-panel-empty">尚未开始协作。</p> : null}
      {snapshot ? (
        <dl>
          {snapshot.goal ? (
            <div>
              <dt>目标</dt>
              <dd title={snapshot.goal}>{snapshot.goal}</dd>
            </div>
          ) : null}
          <div>
            <dt>方案</dt>
            <dd>{implementationLabel(snapshot)}</dd>
          </div>
          <div>
            <dt>审查</dt>
            <dd>{reviewLabel(snapshot)}</dd>
          </div>
          <div>
            <dt>交付</dt>
            <dd>{deliveryLabel(snapshot)}</dd>
          </div>
          <div>
            <dt>验收</dt>
            <dd>{acceptanceLabel(snapshot)}</dd>
          </div>
        </dl>
      ) : null}
      {snapshot?.blocker ? (
        <p className="react-collab-blocker" role="status">
          {BLOCKER_LABELS[snapshot.blocker] || snapshot.blocker}
        </p>
      ) : null}
    </section>
  );
}

function phaseLabel(phase: string | undefined) {
  if (!phase) return "未开始";
  return PHASE_LABELS[phase] || phase;
}

function implementationLabel(snapshot: CollaborationSnapshot) {
  const status = snapshot.implementation.status;
  if (!status) return "未到";
  return IMPLEMENTATION_LABELS[status] || status;
}

function reviewLabel(snapshot: CollaborationSnapshot) {
  if (snapshot.review.verdict === "approve" || snapshot.review.status === "approved")
    return "已通过";
  if (
    snapshot.review.verdict === "changes_requested" ||
    snapshot.review.status === "changes_requested"
  ) {
    return "需修改";
  }
  if (snapshot.phase === "review") return "进行中";
  return "未到";
}

function deliveryLabel(snapshot: CollaborationSnapshot) {
  if (snapshot.delivery.status === "verified") return "已核验";
  if (snapshot.delivery.status === "recorded") return "已记录";
  if (snapshot.phase === "deliver") return "进行中";
  return "未到";
}

function acceptanceLabel(snapshot: CollaborationSnapshot) {
  if (snapshot.acceptance.verdict === "accept" || snapshot.acceptance.status === "accepted") {
    return "已接受";
  }
  if (snapshot.acceptance.verdict === "reject" || snapshot.acceptance.status === "rejected") {
    return "已拒绝";
  }
  if (snapshot.phase === "deliver" || snapshot.phase === "done") return "待 Codex 验收";
  return "未到";
}
