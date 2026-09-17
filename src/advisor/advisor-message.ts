/**
 * Display-only transcript card for advisor notes injected into the primary
 * session. The model-facing message remains the structured `<advisory>` text;
 * this renderer only controls how the message is presented to the person using
 * pi.
 *
 * Unlike the upstream compact rail renderer, this card is deliberately
 * full-width and never collapses notes. Advisor output is an independent voice
 * in the conversation, so it should be immediately recognizable without
 * hiding any of what that voice said.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AdvisorNote, AdvisorSeverity } from "./advise-logic.ts";

export interface AdvisorMessageDetails {
  notes?: AdvisorNote[];
}

type AdvisorColor = "error" | "warning" | "muted";

/** blocker → error, concern → warning, nit/unspecified → muted. */
function severityColor(severity: AdvisorSeverity | undefined): AdvisorColor {
  switch (severity) {
    case "blocker":
      return "error";
    case "concern":
      return "warning";
    default:
      return "muted";
  }
}

function severityRank(severity: AdvisorSeverity | undefined): number {
  switch (severity) {
    case "blocker":
      return 2;
    case "concern":
      return 1;
    default:
      return 0;
  }
}

function strongestSeverity(notes: readonly AdvisorNote[]): AdvisorSeverity | undefined {
  let strongest: AdvisorSeverity | undefined;
  for (const note of notes) {
    if (severityRank(note.severity) > severityRank(strongest)) strongest = note.severity;
  }
  return strongest;
}

function textContent(rawContent: string | readonly { type: string; text?: string }[]): string {
  if (typeof rawContent === "string") return rawContent;
  return rawContent
    .map(block => (block.type === "text" ? (block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

class AdvisorMessageCard implements Component {
  constructor(
    private readonly notes: readonly AdvisorNote[],
    private readonly fallbackContent: string,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    // Styling and wrapping are computed from the current theme and width on
    // every render, so there is no cached state to invalidate.
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width < 8) return [truncateToWidth("Advisor", width, "")];

    const insideWidth = width - 2;
    const contentWidth = Math.max(1, insideWidth - 2);
    const strongest = strongestSeverity(this.notes);
    const border = (text: string): string => this.theme.fg(severityColor(strongest), text);

    const noteCount = this.notes.length;
    const blockers = this.notes.filter(note => note.severity === "blocker").length;
    const concerns = this.notes.filter(note => note.severity === "concern").length;
    const summary = [
      `${noteCount || 1} ${noteCount === 1 || noteCount === 0 ? "note" : "notes"}`,
      blockers > 0 ? `${blockers} blocker${blockers === 1 ? "" : "s"}` : undefined,
      concerns > 0 ? `${concerns} concern${concerns === 1 ? "" : "s"}` : undefined,
    ].filter((part): part is string => part !== undefined);

    const header = truncateToWidth(`─ Advisor · ${summary.join(" · ")} `, insideWidth, "");
    // A lone note with a title IS the card, so its title becomes the card's
    // headline in the top rule; multi-note cards keep titles on their own
    // label lines below so the header stays an honest summary.
    const loneTitle = this.notes.length === 1 ? this.notes[0]!.shortTitle : undefined;
    const headline = loneTitle ? truncateToWidth(`─ ${loneTitle} `, insideWidth - visibleWidth(header), "") : "";
    const headerFill = "─".repeat(Math.max(0, insideWidth - visibleWidth(header) - visibleWidth(headline)));
    const lines: string[] = [border(`╭${header}${loneTitle ? this.theme.bold(headline) : ""}${headerFill}╮`)];

    const frameLine = (content: string): void => {
      const clipped = truncateToWidth(content, contentWidth, "");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
      const body = this.theme.bg("customMessageBg", ` ${clipped}${padding} `);
      lines.push(`${border("│")}${body}${border("│")}`);
    };

    const wrapped = (content: string): string[] => {
      if (content.length === 0) return [""];
      const result = wrapTextWithAnsi(content, contentWidth);
      return result.length > 0 ? result : [""];
    };

    if (this.notes.length === 0) {
      for (const line of this.fallbackContent.split("\n")) {
        for (const part of wrapped(this.theme.fg("customMessageText", line))) frameLine(part);
      }
    } else {
      this.notes.forEach((note, index) => {
        if (index > 0) frameLine("");
        const updateSuffix = note.updateOnId ? " (UPDATE)" : "";
        const label = (note.severity?.toUpperCase() ?? "NOTE") + updateSuffix;
        const source = note.advisor ? `  ${this.theme.fg("dim", note.advisor)}` : "";
        const title = note.shortTitle && !loneTitle ? `  ${this.theme.bold(note.shortTitle)}` : "";
        frameLine(`${this.theme.fg(severityColor(note.severity), this.theme.bold(label))}${source}${title}`);

        for (const line of note.note.split("\n")) {
          for (const part of wrapped(this.theme.fg("customMessageText", line))) frameLine(part);
        }
      });
    }

    lines.push(border(`╰${"─".repeat(insideWidth)}╯`));
    return lines;
  }
}

/** Render one advisory batch as a full-width, non-collapsing transcript card. */
export function renderAdvisorMessage(
  details: AdvisorMessageDetails | undefined,
  rawContent: string | readonly { type: string; text?: string }[],
  _options: { expanded: boolean; outputPad?: number },
  theme: Theme,
): Component | undefined {
  const content = textContent(rawContent);
  const notes = details?.notes ?? [];
  if (notes.length === 0 && !content.trim()) return undefined;
  return new AdvisorMessageCard(notes, content, theme);
}
