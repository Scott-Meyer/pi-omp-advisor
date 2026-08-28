/**
 * Ported from oh-my-pi `src/advisor/advise-tool.ts` (npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`) — the pure, framework-agnostic
 * functions and the `AdviseTool`-equivalent state machine. Logic is
 * unchanged from upstream; only omp-internal type imports
 * (`@oh-my-pi/omptype`, `@oh-my-pi/pi-agent-core`, `@oh-my-pi/pi-utils`) are
 * replaced with local equivalents. See ../../PROVENANCE.md.
 */

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
  note: string;
  severity?: AdvisorSeverity;
  /** Which configured advisor produced this note (omitted for the default/unnamed advisor). */
  advisor?: string;
}

/** One queued advice note. */
export interface AdvisorNote {
  note: string;
  severity?: AdvisorSeverity;
  advisor?: string;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Behavioral framing for the watched agent — advice, not orders. Carried as
 * a tag attribute (rather than a prose header) so the rendered agent-facing
 * output stays a clean `<advisory>` block. The primary agent's system
 * prompt never mentions advisories, so this is its only cue for how to
 * treat them.
 */
const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

/**
 * Render a batch of advisor notes as the agent-facing message body: one
 * `<advisory>` element per note, severity as an attribute. Shared by the
 * non-interrupting aside dispatcher and the interrupting steer path so both
 * build byte-identical content.
 */
export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
  return notes
    .map(n => {
      const severity = n.severity ? ` severity="${n.severity}"` : "";
      const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
      return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
    })
    .join("\n");
}

/**
 * Whether advice at this severity should interrupt the running agent
 * (delivered via the steering channel) rather than ride the
 * non-interrupting aside queue that lands at the next step boundary. A
 * plain `nit` always queues; `concern` and `blocker` interrupt.
 */
export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
  return severity === "concern" || severity === "blocker";
}

/** How an advisor note is routed to the primary. */
export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";

/** Half-open turn-count fence for the post-interrupt cooldown. */
export function isAdvisorInterruptImmuneTurnActive(opts: {
  completedTurns: number;
  immuneTurnStart: number | undefined;
  immuneTurns: number;
}): boolean {
  if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
  return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

/**
 * Decide how one advisor note reaches the primary agent.
 *
 * - A `preserveOnly` caller records every note that arrives while the
 *   primary is idle as a visible card and never starts a new primary turn.
 * - A non-interrupting `nit` always rides the non-interrupting aside queue.
 * - An interrupting `concern`/`blocker` is normally steered into the agent:
 *   into the live turn while one is streaming, or (when idle) a triggered
 *   turn so the advice is acted on immediately.
 * - If the primary tail is already a terminal text answer and there is no
 *   queued work, a late `concern` is preserved as a visible card instead of
 *   waking the primary to restate completion. A `blocker` is the exception:
 *   it means the agent handed off broken or unexercised work, so it still
 *   steers a triggered turn to force the primary to acknowledge and
 *   continue before the turn is considered done — deferring it to the next
 *   user turn is the bug.
 * - After a deliberate user interrupt (`autoResumeSuppressed`) the advisor
 *   must not auto-resume the stopped run. While the agent is idle — or
 *   still tearing the interrupted turn down (`aborting`) — the note is
 *   preserved as a visible card instead of restarting the run. But once a
 *   turn is actively streaming again (a resume the user already drove),
 *   steering the note in does NOT auto-resume anything, so it is delivered
 *   live. Parking it during an active run instead strands it (it never
 *   reaches the running agent) and the withheld notes dump as one burst at
 *   the next user prompt — the bug this guards.
 * - During the post-interrupt immune-turn window, further `concern` notes
 *   are downgraded to asides; preservation still wins. A `blocker` is
 *   exempt: it means the agent handed off broken or unexercised work, so it
 *   still steers a triggered turn even right after a prior interrupt.
 */
export function resolveAdvisorDeliveryChannel(opts: {
  severity: AdvisorSeverity | undefined;
  autoResumeSuppressed: boolean;
  streaming: boolean;
  aborting: boolean;
  terminalAnswerNoQueuedWork?: boolean;
  interruptImmuneTurnActive?: boolean;
  preserveOnly?: boolean;
}): AdvisorDeliveryChannel {
  if (opts.preserveOnly && !opts.streaming) return "preserve";
  if (!isInterruptingSeverity(opts.severity)) return "aside";
  if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
  if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming && !opts.aborting)
    return "preserve";
  if (opts.interruptImmuneTurnActive && opts.severity !== "blocker") return "aside";
  return "steer";
}

/**
 * The tools an advisor receives by default when its config omits `tools` —
 * the read-only investigative set. Upstream names are `read`, `grep`,
 * `glob`; pi's built-in glob-pattern file finder is named `find` (the same
 * relationship upstream's own `find`→`glob` legacy alias captures for its
 * own history) — see PROVENANCE.md item 1. The full available pool is every
 * built tool the session has; a config's `tools` selects from it.
 */
export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

/** Upstream tool name -> pi built-in tool name, for names that differ between the two projects. */
export const ADVISOR_TOOL_NAME_ALIASES: ReadonlyMap<string, string> = new Map([["glob", "find"]]);

/** Resolve one WATCHDOG.yml-style tool name to pi's actual built-in tool name. */
export function resolveAdvisorToolName(name: string): string {
  return ADVISOR_TOOL_NAME_ALIASES.get(name) ?? name;
}

function advisorNoteDedupeKey(note: string): string {
  return note.trim().replace(/\s+/g, " ");
}

/**
 * Rank advisor severities so the dedupe state can detect a real escalation
 * (nit → concern → blocker) versus a verbatim repeat. `undefined` defers to
 * `nit` because the schema treats an omitted severity as a plain nit.
 */
const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
export function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
  return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

/**
 * State machine backing the `advise` tool: escalation-rank dedupe plus
 * mid-turn deferral. One instance per advisor. Framework-agnostic — the pi
 * `defineTool` wrapper (./advise-tool.ts) owns the actual tool
 * registration/schema and calls into this.
 */
export class AdviseState {
  /**
   * Highest delivered severity rank per normalized note. A new call passes
   * through only when its rank strictly exceeds the recorded one (a real
   * escalation: nit → concern → blocker), so an advisor cannot bypass
   * dedupe by retagging the same text at a lower or equal severity.
   */
  #deliveredNoteSeverities = new Map<string, number>();
  #inProgressUpdate = false;
  /**
   * Notes withheld while the primary was mid-turn, in arrival order.
   * Flushed deterministically on the first `beginUpdate(false)` so delivery
   * does not depend on the advisor model choosing to re-raise (it may not,
   * since the tool previously returned "Recorded." for a note that was
   * never routed). Cleared on `resetDeliveredNotes` alongside the
   * delivered-rank map.
   */
  #deferredNotes: { key: string; note: string; severity?: AdvisorSeverity }[] = [];

  constructor(private readonly onAdvice: (note: string, severity: AdvisorSeverity | undefined) => void) {}

  /**
   * Mark whether the next advisor prompt reviews an in-progress primary
   * turn. Non-blockers are withheld until a completed update so partial
   * work does not interrupt the primary before it can finish its planned
   * steps.
   */
  beginUpdate(inProgress: boolean): void {
    const wasInProgress = this.#inProgressUpdate;
    this.#inProgressUpdate = inProgress;
    if (wasInProgress && !inProgress && this.#deferredNotes.length > 0) {
      const pending = this.#deferredNotes;
      this.#deferredNotes = [];
      for (const { note, severity } of pending) this.#deliver(note, severity);
    }
  }

  /** Clear delivered-note memory when the advisor starts a fresh conversation. */
  resetDeliveredNotes(): void {
    this.#deliveredNoteSeverities.clear();
    this.#inProgressUpdate = false;
    this.#deferredNotes = [];
  }

  /**
   * Handle one `advise()` call. Returns the tool-result text plus whether
   * the note was actually delivered (routed to `onAdvice`).
   */
  submit(note: string, severity: AdvisorSeverity | undefined): { text: string; delivered: boolean } {
    if (this.#inProgressUpdate && severity !== "blocker") {
      const key = advisorNoteDedupeKey(note);
      const pending = this.#deferredNotes.find(item => item.key === key);
      if (!pending) {
        this.#deferredNotes.push({ key, note, severity });
      } else if (advisorSeverityRank(severity) > advisorSeverityRank(pending.severity)) {
        pending.severity = severity;
      }
      return {
        text: "Deferred — primary is mid-turn; this note will be delivered automatically when the turn completes. Do not re-raise the same point.",
        delivered: false,
      };
    }
    const delivered = this.#deliver(note, severity);
    return { text: delivered ? "Recorded." : "Duplicate advice ignored.", delivered };
  }

  /**
   * Run one note through the escalation-rank dedupe and, if it passes,
   * route it to the primary. Returns true when the note was actually
   * delivered. Shared by the live path (`submit`) and the deferred flush
   * (`beginUpdate(false)`).
   */
  #deliver(note: string, severity: AdvisorSeverity | undefined): boolean {
    const key = advisorNoteDedupeKey(note);
    const rank = advisorSeverityRank(severity);
    const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
    if (rank <= previousRank) return false;
    this.#deliveredNoteSeverities.set(key, rank);
    this.onAdvice(note, severity);
    return true;
  }
}
