/**
 * Display-only transcript card for advisor notes injected into the primary
 * session — the pi equivalent of oh-my-pi's
 * `src/modes/components/advisor-message.ts` (`createAdvisorMessageCard`, npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`), rebuilt against pi's own
 * `registerMessageRenderer` hook and `Theme` API.
 *
 * Styled as a distinct voice so notes never blend into thinking output (whose
 * `thinkingText` color equals `toolOutput` in most themes): a bold
 * `customMessageLabel` header tag, a heavy rail tinted per-note severity, and
 * the note body on the custom-message text color.
 *
 * Deviations from upstream, all forced by pi's narrower theme surface: pi's
 * `Theme` exposes `fg`/`bg`/`bold` but has no `status` icon set, no
 * `symbol()` registry (so the rail glyph is inlined rather than themeable),
 * and no `sep` separators. Upstream's `wrapVarying` two-width body wrap is
 * replaced by pi's own `Text` wrapping.
 */
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AdvisorNote, AdvisorSeverity } from "./advise-logic.ts";

/** Upstream `advisor.rail` symbol default. */
const RAIL = "▎";
/** Upstream's collapsed-card note cap. */
const COLLAPSED_NOTES = 3;

export interface AdvisorMessageDetails {
  notes?: AdvisorNote[];
}

/** Upstream `severityColor`: blocker → error, concern → warning, nit → muted. */
function severityColor(severity: AdvisorSeverity | undefined): "error" | "warning" | "muted" {
  switch (severity) {
    case "blocker":
      return "error";
    case "concern":
      return "warning";
    default:
      return "muted";
  }
}

function badge(severity: AdvisorSeverity | undefined, theme: Theme): string {
  if (!severity) return "";
  return `${theme.fg(severityColor(severity), theme.bold(severity.toUpperCase()))} `;
}

/**
 * Render one `<advisory>` batch as a card. Falls back to `undefined` when the
 * message carries no structured notes, which makes pi use its own default
 * custom-message rendering rather than showing an empty card.
 */
export function renderAdvisorMessage(
  details: AdvisorMessageDetails | undefined,
  // Custom-message content is `string | (TextContent | ImageContent)[]`; an
  // advisory is always built as a plain string, but the array form is flattened
  // rather than assumed away so a restored/foreign message cannot crash render.
  rawContent: string | readonly { type: string; text?: string }[],
  options: { expanded: boolean; outputPad?: number },
  theme: Theme,
): Text | undefined {
  const content =
    typeof rawContent === "string"
      ? rawContent
      : rawContent
          .map(block => (block.type === "text" ? (block.text ?? "") : ""))
          .filter(Boolean)
          .join("\n");
  const notes = details?.notes ?? [];
  if (notes.length === 0) {
    // No structured details (e.g. a message restored from an older session):
    // show the raw content under the same header rather than nothing.
    if (!content.trim()) return undefined;
    const header = theme.bold(theme.fg("customMessageLabel", `${RAIL} Advisor`));
    return new Text(`${header}\n${theme.fg("customMessageText", content)}`, options.outputPad ?? 0, 0);
  }

  const blockers = notes.filter(n => n.severity === "blocker").length;
  const meta: string[] = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
  if (blockers > 0) meta.push(theme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`));

  const header = theme.bold(theme.fg("customMessageLabel", `${RAIL} Advisor`));
  const lines: string[] = [`${header} ${theme.fg("dim", meta.join(" · "))}`];

  const shown = options.expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
  for (const note of shown) {
    const rail = theme.fg(severityColor(note.severity), RAIL);
    // Multi-advisor: attribute the note to its source. The implicit single
    // advisor renders unlabeled, matching upstream.
    const who = note.advisor ? `${theme.fg("dim", `[${note.advisor}]`)} ` : "";
    const body = note.note.split("\n").filter(p => p.trim());
    body.forEach((line, index) => {
      const prefix = index === 0 ? `${badge(note.severity, theme)}${who}` : "";
      lines.push(`  ${rail} ${prefix}${theme.fg("customMessageText", line)}`);
    });
  }

  const hidden = notes.length - shown.length;
  if (hidden > 0) {
    lines.push(
      `  ${theme.fg("dim", RAIL)} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`,
    );
  }

  return new Text(lines.join("\n"), options.outputPad ?? 0, 0);
}
