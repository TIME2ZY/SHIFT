import statuses from "../../../../src/shared/tool-status.json";
export type ToolStatus = keyof typeof statuses;
export function projectToolStatus(status?: string, failed = false): ToolStatus {
  const match = (Object.keys(statuses) as ToolStatus[]).find((key) =>
    statuses[key].includes(status || "")
  );
  if (match === "cancelled" || match === "interrupted") return match;
  return failed || match === "error" ? "error" : "done";
}
