/** OMP's advise tool plus controls for this advisor's still-pending notes. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AdviseState, type AdvisorSeverity, type PendingAdviceAccess, type PendingAdvisorNote } from "./advise-logic.ts";
import type { PrimaryStopAccess } from "./primary-stop.ts";
import { makeStopTools } from "./stop-tools.ts";

const adviseDescription = new URL("../prompts/advise-tool.md", import.meta.url);
export const ADVISOR_COMMUNICATION_TOOLS = ["advise", "pending_advice", "revise_advice", "withdraw_advice"] as const;

const adviseSeverity = StringEnum(["nit", "concern", "blocker"] as const, {
  description: "How strongly to weigh this. Omit for a plain nit.",
});

/**
 * The emission guard gates new notes before they enter AdviseState. Revisions
 * edit an existing note without spending another new-note slot or changing
 * urgency. Successful revisions register their text through rememberRevision
 * so the emission guard also recognizes duplicates. A context rebuild can
 * reuse the state so pending IDs stay valid.
 */
export async function makeAdviseTool(
  onAdvice: (note: PendingAdvisorNote) => void,
  accept: (note: string) => boolean = () => true,
  pendingAccess?: PendingAdviceAccess,
  existingState?: AdviseState,
  stopAccess?: PrimaryStopAccess,
  rememberRevision: (note: string) => void = () => {},
): Promise<{ tool: ReturnType<typeof defineTool>; controlTools: ReturnType<typeof defineTool>[]; state: AdviseState }> {
  const fs = await import("node:fs/promises");
  const description = await fs.readFile(adviseDescription, "utf8");
  const state = existingState ?? new AdviseState(onAdvice, pendingAccess);
  const tool = defineTool({
    name: "advise",
    label: "Advise",
    description,
    parameters: Type.Object({
      note: Type.String({ description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable." }),
      severity: Type.Optional(adviseSeverity),
    }),
    async execute(_toolCallId, params) {
      if (process.env.PI_ADVISOR_DEBUG === "1") {
        console.error(`[advisor:debug] advise() called severity=${params.severity ?? "nit"} note=${JSON.stringify(params.note.slice(0, 160))}`);
      }
      if (!accept(params.note)) {
        if (process.env.PI_ADVISOR_DEBUG === "1") {
          console.error("[advisor:debug] advise() suppressed by emission guard (noise, duplicate, or over per-update budget)");
        }
        // No receipt for a filtered note. This does not invite a rewording
        // loop, and no longer claims that nonexistent pending advice was saved.
        return {
          content: [{ type: "text", text: "No new advice queued. Continue reviewing the next update rather than rephrasing this submission." }],
          details: { note: params.note, severity: params.severity, adviceId: undefined as string | undefined, suppressed: true },
          useless: true,
        };
      }
      const result = state.submit(params.note, params.severity as AdvisorSeverity | undefined);
      return {
        content: [{ type: "text", text: result.text }],
        details: { note: params.note, severity: params.severity, adviceId: result.adviceId, suppressed: false },
        useless: true,
      };
    },
  });

  const pending = defineTool({
    name: "pending_advice",
    label: "Pending advice",
    description: "Inspect your own unsent advice: deferred notes and notes still in the extension's queue. Handed-off or removed messages are absent. Shows up to 20 notes per page.",
    parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0, description: "Start at this offset for another page." })) }),
    async execute(_id, params) {
      const notes = state.pendingAdvice();
      const offset = params.offset ?? 0;
      const result = { pending: notes.slice(offset, offset + 20), total: notes.length, nextOffset: offset + 20 < notes.length ? offset + 20 : null };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  const revise = defineTool({
    name: "revise_advice",
    label: "Revise pending advice",
    description: "Replace the text of your pending advice when newer evidence changes it. Keeps its ID and severity; does not send a new message. Cannot edit anything already handed to Pi or removed by the user.",
    parameters: Type.Object({
      adviceId: Type.String({ description: "The adviceId returned by advise or pending_advice." }),
      note: Type.String({ minLength: 1, description: "Replacement advice text." }),
    }),
    async execute(_id, params) {
      const result = state.revise(params.adviceId, params.note);
      if (result.changed) rememberRevision(params.note);
      return { content: [{ type: "text", text: result.text }], details: result };
    },
  });
  const withdraw = defineTool({
    name: "withdraw_advice",
    label: "Withdraw pending advice",
    description: "Remove your pending advice when it is no longer useful. This cannot recall a message already handed to Pi, even if the primary has not read it yet.",
    parameters: Type.Object({ adviceId: Type.String({ description: "The adviceId returned by advise or pending_advice." }) }),
    async execute(_id, params) {
      const result = state.withdraw(params.adviceId);
      return { content: [{ type: "text", text: result.text }], details: result };
    },
  });
  return { tool, controlTools: [pending, revise, withdraw, ...(stopAccess ? makeStopTools(stopAccess) : [])], state };
}
