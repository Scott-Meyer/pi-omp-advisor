/**
 * The `advise` tool itself: pi `defineTool` wrapper around `AdviseState`
 * (../advise-logic.ts). Schema and description are byte-identical to
 * upstream (npm `@oh-my-pi/pi-coding-agent@17.4.1`,
 * `src/advisor/advise-tool.ts` + `src/prompts/advisor/advise-tool.md`).
 * There is deliberately only this one tool — no separate "stop" tool.
 * `blocker` severity routes through the same delivery-channel logic as
 * `concern`; see ../../PROVENANCE.md item 2 for the steer/aside/preserve →
 * pi primitive mapping. See ../../PROVENANCE.md.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AdviseState, type AdvisorSeverity } from "./advise-logic.ts";

const adviseDescription = new URL("../prompts/advise-tool.md", import.meta.url);

async function loadAdviseDescription(): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(adviseDescription, "utf8");
}

const adviseSeverity = StringEnum(["nit", "concern", "blocker"] as const, {
  description: "How strongly to weigh this. Omit for a plain nit.",
});

/**
 * Build the `advise` tool for one advisor. `onAdvice` is called only for
 * notes that actually pass the escalation-rank dedupe (mirrors upstream:
 * `AdviseTool`'s constructor callback fires only from `#deliver`, whether
 * called live or from the deferred-flush path).
 *
 * `accept` is the caller's emission-guard gate (noise filter + one-accepted-
 * note-per-update budget). It runs HERE, at the tool-call boundary, before
 * the note can enter `AdviseState` at all — upstream's "gate at the
 * `enqueueAdvice` boundary" (see ./emission-guard.ts). Gating downstream of
 * `AdviseState` instead is wrong two ways: `#deliver` records a note's
 * severity rank in the delivered map *before* invoking `onAdvice`, so a
 * note the guard then refuses is permanently marked delivered and
 * dedupe-blocked from ever being re-raised; and a deferred-note flush pushes
 * N notes through a budget of 1, marking all N delivered while routing one.
 * Gating at entry keeps "recorded as delivered" and "actually routed" the
 * same set, and bounds what enters the deferred queue in the first place.
 *
 * Suppression is deliberately invisible to the advisor model: a refused call
 * returns the same "Recorded." text as an accepted one, because surfacing
 * "suppressed" invites the model to rephrase the same useless note to bypass
 * the filter ("Stop." → "Halt." → "Stop now.").
 */
export async function makeAdviseTool(
  onAdvice: (note: string, severity: AdvisorSeverity | undefined) => void,
  accept: (note: string) => boolean = () => true,
): Promise<{ tool: ReturnType<typeof defineTool>; state: AdviseState }> {
  const description = await loadAdviseDescription();
  const state = new AdviseState(onAdvice);
  const tool = defineTool({
    name: "advise",
    label: "Advise",
    description,
    parameters: Type.Object({
      note: Type.String({
        description: "One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
      }),
      severity: Type.Optional(adviseSeverity),
    }),
    async execute(_toolCallId, params) {
      if (process.env.PI_ADVISOR_DEBUG === "1") {
        console.error(
          `[advisor:debug] advise() called severity=${params.severity ?? "nit"} note=${JSON.stringify(params.note.slice(0, 160))}`,
        );
      }
      if (!accept(params.note)) {
        if (process.env.PI_ADVISOR_DEBUG === "1") {
          console.error("[advisor:debug] advise() suppressed by emission guard (noise, duplicate, or over per-update budget)");
        }
        return {
          content: [{ type: "text", text: "Recorded." }],
          details: { note: params.note, severity: params.severity, suppressed: true },
          useless: true,
        };
      }
      const { text } = state.submit(params.note, params.severity as AdvisorSeverity | undefined);
      return {
        content: [{ type: "text", text }],
        details: { note: params.note, severity: params.severity, suppressed: false },
        useless: true,
      };
    },
  });
  return { tool, state };
}
