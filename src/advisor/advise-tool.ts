/** OMP's advise tool plus controls for this advisor's still-pending notes. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AdviseState, type AdvisorSeverity, type PendingAdviceAccess, type PendingAdvisorNote } from "./advise-logic.ts";
import type { PrimaryStopAccess } from "./primary-stop.ts";
import { makeStopTools } from "./stop-tools.ts";

const adviseDescription = new URL("../prompts/advise-tool.md", import.meta.url);
export const ADVISOR_COMMUNICATION_TOOLS = ["advise", "update_advice", "pending_advice", "revise_advice", "withdraw_advice"] as const;

const adviseSeverity = StringEnum(["nit", "concern", "blocker"] as const, {
  description: "How strongly to weigh this. Omit for a plain nit.",
});

export type EmissionCheckOutcome = boolean | {
  accepted: boolean;
  reason?: "empty" | "noise" | "duplicate" | "budget_exceeded";
  allowance?: { used: number; total: number };
};

/**
 * The emission guard gates new notes before they enter AdviseState. Revisions
 * edit an existing note without spending another new-note slot or changing
 * urgency. Successful revisions register their text through rememberRevision
 * so the emission guard also recognizes duplicates. A context rebuild can
 * reuse the state so pending IDs stay valid.
 */
export async function makeAdviseTool(
  onAdvice: (note: PendingAdvisorNote) => void,
  accept: (note: string) => EmissionCheckOutcome = () => true,
  pendingAccess?: PendingAdviceAccess,
  existingState?: AdviseState,
  stopAccess?: PrimaryStopAccess,
  rememberRevision: (note: string) => void = () => {},
  forgetNote: (note: string) => void = () => {},
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
      ShortTitle: Type.Optional(Type.String({ description: "Optional: a few plain words naming the point, e.g. \"Test gap in flush logic\". The inbox UI leads with this when present, so someone skimming ten advisories can tell them apart at a glance." })),
    }),
    async execute(_toolCallId, params) {
      const shortTitle = params.ShortTitle;
      if (process.env.PI_ADVISOR_DEBUG === "1") {
        console.error(`[advisor:debug] advise() called severity=${params.severity ?? "nit"} title=${JSON.stringify(shortTitle ?? "")} note=${JSON.stringify(params.note.slice(0, 160))}`);
      }
      const checkResult = accept(params.note);
      const isAccepted = typeof checkResult === "boolean" ? checkResult : checkResult.accepted;
      const allowance = typeof checkResult === "object" ? checkResult.allowance : undefined;
      const reason = typeof checkResult === "object" ? checkResult.reason : undefined;

      if (!isAccepted) {
        if (process.env.PI_ADVISOR_DEBUG === "1") {
          console.error(`[advisor:debug] advise() suppressed by emission guard reason=${reason ?? "filter"}`);
        }
        let failText = "No new advice queued. Continue reviewing the next update rather than rephrasing this submission.";
        if (reason === "budget_exceeded") {
          failText = `Review allowance reached (${allowance?.used ?? 3} of ${allowance?.total ?? 3} notes used this cycle). Use update_advice to consolidate or sharpen an existing note, or review in the next update.`;
        }
        const failTextWithQueue = `${failText}\n\n${state.formatQueueSnapshot()}`;
        return {
          content: [{ type: "text", text: failTextWithQueue }],
          details: { note: params.note, severity: params.severity, shortTitle, adviceId: undefined as string | undefined, suppressed: true, reason: reason as "budget_exceeded" | "duplicate" | "empty" | "noise" | undefined, allowance: allowance as { used: number; total: number } | undefined },
          useless: true,
        };
      }
      const result = state.submit(params.note, params.severity as AdvisorSeverity | undefined, shortTitle);
      const allowanceTag = allowance ? ` [Review allowance: ${allowance.used} of ${allowance.total} used this cycle]` : "";
      const textWithAllowance = result.text.includes("Recorded advice")
        ? result.text.replace("Recorded advice", "Recorded advice" + allowanceTag)
        : result.text.replace("Deferred advice", "Deferred advice" + allowanceTag);

      return {
        content: [{ type: "text", text: textWithAllowance }],
        details: { note: params.note, severity: params.severity, shortTitle, adviceId: result.adviceId, suppressed: false, reason: undefined as "budget_exceeded" | "duplicate" | "empty" | "noise" | undefined, allowance: allowance as { used: number; total: number } | undefined },
        useless: true,
      };
    },
  });

  const updateAdvice = defineTool({
    name: "update_advice",
    label: "Update advice",
    description: "Update an existing advice note with newer evidence, sharper analysis, or a consolidated thought. If the note is still in review or queued in the inbox, it updates in place. If it was already delivered into the primary agent's live stream, it delivers as a follow-up note referencing the original. If the operator already dismissed it, the dismissal is respected. The tool response will show your current pending queue.",
    parameters: Type.Object({
      targetId: Type.String({ description: "The advice ID of the earlier note you want to update (from your previous tool call response or observation)." }),
      note: Type.String({ minLength: 1, description: "Replacement or follow-up advice text." }),
      ShortTitle: Type.Optional(Type.String({ description: "Optional: Updated short title for the note. Omit to keep the original title." })),
      severity: Type.Optional(adviseSeverity),
    }),
    async execute(_id, params) {
      const result = state.update(params.targetId, params.note, params.ShortTitle, params.severity as AdvisorSeverity | undefined);
      if (result.changed) {
        if (result.oldNote) forgetNote(result.oldNote);
        rememberRevision(params.note);
      }
      return {
        content: [{ type: "text", text: result.text }],
        details: { targetId: params.targetId, note: params.note, ShortTitle: params.ShortTitle, severity: params.severity, outcome: result.outcome },
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
      ShortTitle: Type.Optional(Type.String({ description: "Optional replacement title; omit to keep the current one." })),
    }),
    async execute(_id, params) {
      const result = state.revise(params.adviceId, params.note, params.ShortTitle);
      if (result.changed) {
        if (result.oldNote) forgetNote(result.oldNote);
        rememberRevision(params.note);
      }
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
      if (result.changed && result.withdrawnNote) {
        forgetNote(result.withdrawnNote);
      }
      return { content: [{ type: "text", text: result.text }], details: result };
    },
  });
  return { tool, controlTools: [updateAdvice, pending, revise, withdraw, ...(stopAccess ? makeStopTools(stopAccess) : [])], state };
}
