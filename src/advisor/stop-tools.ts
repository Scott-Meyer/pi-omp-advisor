import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PrimaryStopAccess } from "./primary-stop.ts";

export const ADVISOR_STOP_TOOLS = ["current_tool", "request_stop"] as const;

/** Exposed only when this advisor has an explicit request_stop grant. */
export function makeStopTools(access: PrimaryStopAccess): ReturnType<typeof defineTool>[] {
  const current = defineTool({
    name: "current_tool",
    label: "Current primary tool",
    description: "Inspect the primary's sole in-flight foreground tool call, if any. Returns its unique targetId, toolCallId, and a compact argument summary, not tool output. A call can still be in preflight. No access to detached background jobs.",
    parameters: Type.Object({}),
    async execute() {
      const result = access.currentTool();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  const stop = defineTool({
    name: "request_stop",
    label: "Request primary cancellation",
    description: "Exceptional stop request for a concrete imminent harm, or an explicit user-requested cancellation test. Requires the exact targetId of the execution you intend to stop and a visible reason. Pi aborts the active turn containing that call, so this refuses idle, stale, already-aborting, or multiple-call targets. Acceptance means cancellation requested—not proven termination or undo. No automatic restart, background-job control, or arbitrary process access. Ordinary advice still uses advise.",
    parameters: Type.Object({
      targetId: Type.String({ minLength: 1, description: "Unique execution targetId from the intended call's runtime update/current_tool (not its toolCallId). A concern about an older call does not justify stopping a newer one." }),
      reason: Type.String({ minLength: 1, maxLength: 1000, description: "Concrete reason stopping this operation now is warranted. Shown to the user and recorded in the session." }),
    }),
    async execute(_id, params) {
      const result = access.requestStop(params.targetId, params.reason);
      return { content: [{ type: "text", text: result.message }], details: result };
    },
  });
  return [current, stop];
}
