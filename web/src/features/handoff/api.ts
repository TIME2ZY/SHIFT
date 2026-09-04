import { ApiError, authenticatedFetch } from "../../shared/api/client";

export interface HandoffPreviewEdits {
  goal: string;
  completed: string;
  constraints: string[];
  files: string[];
  openQuestions: string[];
  prohibited: string[];
  nextAction: string;
}

async function previewAction(
  sessionId: string,
  previewId: string,
  action: "confirm" | "cancel",
  body: object = {}
) {
  const response = await authenticatedFetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/handoff-previews/${encodeURIComponent(previewId)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok)
    throw new ApiError(payload.error || response.statusText, response.status, payload);
  return payload;
}

export function confirmHandoffPreview(
  sessionId: string,
  previewId: string,
  edits: HandoffPreviewEdits
) {
  return previewAction(sessionId, previewId, "confirm", edits);
}

export function cancelHandoffPreview(sessionId: string, previewId: string) {
  return previewAction(sessionId, previewId, "cancel");
}
