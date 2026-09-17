/**
 * Ported from oh-my-pi `src/advisor/advise-tool.ts` (npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`) — the pure, framework-agnostic
 * functions and the `AdviseTool`-equivalent state machine. The port adds
 * editable pending advice and releases deferred notes after review rather
 * than before it. See ../../PROVENANCE.md.
 */
import { randomUUID } from "node:crypto";

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
  note: string;
  severity?: AdvisorSeverity;
  /** Which configured advisor produced this note (omitted for the default/unnamed advisor). */
  advisor?: string;
  /** Optional human-readable title naming the note's point in a few words. */
  shortTitle?: string;
}

/** One queued advice note. */
export interface AdvisorNote {
  note: string;
  severity?: AdvisorSeverity;
  advisor?: string;
  /** Optional human-readable title naming the note's point in a few words. */
  shortTitle?: string;
  /** Stable receipt shared by deferred advice and the preserved inbox. */
  adviceId?: string;
  createdAt?: number;
  updatedAt?: number;
  /** If this note is a follow-up revision on an earlier delivered note. */
  updateOnId?: string;
}

export interface PendingAdvisorNote extends AdvisorNote {
  adviceId: string;
}

/** Scoped by the host to one advisor; handed-off or removed IDs cannot be edited. */
export interface PendingAdviceAccess {
  list(): PendingAdvisorNote[];
  revise(adviceId: string, note: string, shortTitle?: string, severity?: AdvisorSeverity): boolean;
  withdraw(adviceId: string): boolean;
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
 * output stays a clean `<advisory>` block. The primary agent's system prompt
 * identifies the block's AI-advisor provenance and explains how late follow-up
 * completions appear in the transcript; this attribute remains the cue for how
 * much weight to give the note itself.
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
      const idTag = n.adviceId ? ` id="${escapeXmlAttribute(n.adviceId)}"` : "";
      const severity = n.severity ? ` severity="${n.severity}"` : "";
      const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
      const title = n.shortTitle ? ` title="${escapeXmlAttribute(n.shortTitle)}"` : "";
      const updateTag = n.updateOnId ? ` updateOn="${escapeXmlAttribute(n.updateOnId)}"` : "";
      return `<advisory${idTag}${who}${severity}${title}${updateTag} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
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
 * - During active work, a non-interrupting `nit` rides the aside queue.
 * - An interrupting `concern`/`blocker` is normally steered into the agent:
 *   into the live turn while one is streaming, or (when idle) a triggered
 *   turn so the advice is acted on immediately.
 * - If the primary tail is already a terminal text answer and there is no
 *   queued work, a late `nit` or `concern` stays in the dismissible inbox instead of
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
  if (opts.aborting || (opts.preserveOnly && !opts.streaming)) return "preserve";
  if (opts.autoResumeSuppressed && !opts.streaming) return "preserve";
  if (opts.terminalAnswerNoQueuedWork && opts.severity !== "blocker" && !opts.streaming) return "preserve";
  if (!isInterruptingSeverity(opts.severity)) return "aside";
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
 * intra-review deferral. One instance per advisor. Framework-agnostic — the pi
 * `defineTool` wrapper (./advise-tool.ts) owns the actual tool
 * registration/schema and calls into this.
 *
 * Non-blocker notes are held while `#reviewing` is true so the advisor can
 * investigate with its granted tools and revise or withdraw them before handoff.
 * When `finishUpdate()` is called upon successful review completion, accepted
 * notes are released to the host delivery routing (`resolveAdvisorDeliveryChannel`).
 * Parking notes across updates during an active run would strand them (violating
 * the active-run delivery contract described in {@link resolveAdvisorDeliveryChannel},
 * where withholding notes dumps them as one burst at settle); releasing them at
 * review completion ensures active-run concerns steer immediately, nits queue as
 * asides, and only post-settle notes enter the preserved inbox.
 */
export class AdviseState {
  #deliveredNoteSeverities = new Map<string, number>();
  #reviewing = false;
  #deferredNotes: PendingAdvisorNote[] = [];
  #streamedHistory = new Map<string, PendingAdvisorNote>();
  #trackedNotes = new Map<string, PendingAdvisorNote>();

  constructor(
    private readonly onAdvice: (note: PendingAdvisorNote) => void,
    private readonly pendingAccess?: PendingAdviceAccess,
  ) {}

  /** Begin review without releasing older notes before the model sees the update. */
  beginUpdate(_inProgress?: boolean): void {
    this.#reviewing = true;
  }

  /** Release remaining deferred notes after this review completes successfully. */
  finishUpdate(): void {
    this.#reviewing = false;
    // Remove each note after successful routing so a throwing host does not
    // silently lose the remainder. An unsuccessful review never calls this.
    while (this.#deferredNotes.length > 0) {
      this.#deliver(this.#deferredNotes[0]!);
      this.#deferredNotes.shift();
    }
  }

  /** Discard any unreleased notes from a cancelled, aborted, or failed review and return them. */
  discardDeferredNotes(): PendingAdvisorNote[] {
    this.#reviewing = false;
    const discarded = this.#deferredNotes;
    this.#deferredNotes = [];
    return discarded;
  }

  /** Copies, not live records. External pending advice is scoped by the host. */
  pendingAdvice(): (PendingAdvisorNote & { status: "deferred" | "queued" })[] {
    return [
      ...this.#deferredNotes.map(note => ({ ...note, status: "deferred" as const })),
      ...(this.pendingAccess?.list() ?? []).map(note => ({ ...note, status: "queued" as const })),
    ];
  }

  /** Render a compact, single-turn snapshot of currently pending/queued advice. */
  formatQueueSnapshot(): string {
    const pending = this.pendingAdvice();
    if (pending.length === 0) {
      return "Current pending queue: (empty)";
    }
    const lines = pending.map(item => {
      const preview = item.note.replace(/\s+/g, " ").slice(0, 160);
      const title = item.shortTitle ? ` "${item.shortTitle}"` : "";
      const age = item.createdAt === undefined ? "" : `, ${Math.max(0, Math.floor((Date.now() - item.createdAt) / 1000))}s old`;
      return `• ${item.adviceId} [${item.severity ?? "nit"}${age}]${title}: ${preview}`;
    });
    return [`Current pending queue (${pending.length} ${pending.length === 1 ? "item" : "items"}):`, ...lines].join("\n");
  }

  /**
   * Update an existing note: if still in review or queued in the inbox, updates
   * in place; if already delivered into the primary agent's live stream, delivers
   * as a follow-up note referencing the original. If previously dismissed by the
   * operator, respects the dismissal without resurrecting it into the stream.
   */
  update(
    adviceId: string,
    note: string,
    shortTitle?: string,
    severity?: AdvisorSeverity,
  ): { changed: boolean; text: string; adviceId: string; outcome: "updated_pending" | "delivered_followup" | "dismissed" | "created_new"; oldNote?: string } {
    if (!note.trim()) {
      return { changed: false, text: "An empty update is not advice. Note text is required.", adviceId, outcome: "updated_pending" };
    }

    // Case 1: Check if still deferred in review
    const pending = this.#deferredNotes.find(item => item.adviceId === adviceId);
    if (pending) {
      const oldNote = pending.note;
      const oldSeverity = pending.severity;
      pending.note = note;
      if (shortTitle !== undefined) pending.shortTitle = shortTitle || undefined;
      if (severity !== undefined) pending.severity = severity;
      pending.updatedAt = Date.now();
      this.#trackedNotes.set(adviceId, { ...pending });

      // If escalated from non-blocker to blocker, route immediately rather than staying deferred
      if (pending.severity === "blocker" && oldSeverity !== "blocker") {
        if (this.#deliver(pending)) {
          this.#deferredNotes = this.#deferredNotes.filter(item => item !== pending);
          const statusText = `Updated advice ${adviceId} and escalated to blocker (delivered immediately).\n\n${this.formatQueueSnapshot()}`;
          return { changed: true, text: statusText, adviceId, outcome: "delivered_followup", oldNote };
        }
      }

      const statusText = `Updated pending advice ${adviceId} in place.\n\n${this.formatQueueSnapshot()}`;
      return { changed: true, text: statusText, adviceId, outcome: "updated_pending", oldNote };
    }

    // Case 2: Check if queued in the host inbox / aside queue
    const queued = this.pendingAccess?.list().find(item => item.adviceId === adviceId);
    if (queued) {
      const finalSeverity = severity ?? queued.severity;
      const finalTitle = shortTitle !== undefined ? (shortTitle || undefined) : queued.shortTitle;
      const updatedRecord: PendingAdvisorNote = { ...queued, note, shortTitle: finalTitle, severity: finalSeverity, updatedAt: Date.now() };

      // Only treat an actual severity increase from non-blocker to blocker as immediate escalation
      if (finalSeverity === "blocker" && queued.severity !== "blocker") {
        if (this.#deliver(updatedRecord)) {
          this.pendingAccess?.withdraw(adviceId);
          const statusText = `Escalated queued advice ${adviceId} to blocker and delivered immediately.\n\n${this.formatQueueSnapshot()}`;
          return { changed: true, text: statusText, adviceId, outcome: "delivered_followup" };
        }
      }

      if (this.pendingAccess!.revise(adviceId, note, shortTitle, severity)) {
        const key = advisorNoteDedupeKey(note);
        this.#deliveredNoteSeverities.set(key, Math.max(
          this.#deliveredNoteSeverities.get(key) ?? 0, advisorSeverityRank(finalSeverity),
        ));
        this.#trackedNotes.set(adviceId, updatedRecord);
        const statusText = `Updated queued advice ${adviceId} in the inbox.\n\n${this.formatQueueSnapshot()}`;
        return { changed: true, text: statusText, adviceId, outcome: "updated_pending" };
      }
    }

    // Case 3: Check if already delivered into the primary agent's stream
    const streamed = this.#streamedHistory.get(adviceId);
    if (streamed) {
      const originalTitle = streamed.shortTitle ? ` "${streamed.shortTitle}"` : "";
      const baseTitle = shortTitle ?? streamed.shortTitle;
      const followupTitle = baseTitle ? (baseTitle.startsWith("Update:") ? baseTitle : `Update: ${baseTitle}`) : "Update";
      const followupSeverity = severity ?? streamed.severity;
      const res = this.submit(note, followupSeverity, followupTitle, adviceId);
      if (!res.adviceId) {
        const statusText = `Update on ${adviceId}${originalTitle} was ignored as duplicate content.\n\n${this.formatQueueSnapshot()}`;
        return { changed: false, text: statusText, adviceId, outcome: "delivered_followup" };
      }
      const isStreamed = this.#streamedHistory.has(res.adviceId);
      const deliveryStatus = isStreamed ? "Delivered" : "Queued";
      const statusText = `Original advice ${adviceId}${originalTitle} was already delivered to the live stream. ${deliveryStatus} follow-up advisory note (id: ${res.adviceId}).\n\n${this.formatQueueSnapshot()}`;
      return { changed: true, text: statusText, adviceId: res.adviceId, outcome: "delivered_followup" };
    }

    // Case 4: Was it previously tracked in the inbox, but is no longer present and was not streamed?
    // That means the human operator explicitly dismissed it! Do not resurrect it into the stream.
    if (this.#trackedNotes.has(adviceId)) {
      const statusText = `Original advice ${adviceId} was dismissed by the operator; revision not applied.\n\n${this.formatQueueSnapshot()}`;
      return { changed: false, text: statusText, adviceId, outcome: "dismissed" };
    }

    // Case 5: Unknown ID — reject cleanly so mistyped IDs do not bypass the new-note allowance
    const statusText = `No active, queued, or delivered advice found matching targetId "${adviceId}". Update not applied.\n\n${this.formatQueueSnapshot()}`;
    return { changed: false, text: statusText, adviceId, outcome: "updated_pending" };
  }

  /** Replace content, not urgency; revisions neither create notes nor spend a new-note slot. */
  revise(adviceId: string, note: string, shortTitle?: string): { changed: boolean; text: string; oldNote?: string } {
    if (!note.trim()) return { changed: false, text: "An empty revision is not advice. Use withdraw_advice to remove it." };
    const pending = this.#deferredNotes.find(item => item.adviceId === adviceId);
    if (pending) {
      const oldNote = pending.note;
      pending.note = note;
      if (shortTitle !== undefined) pending.shortTitle = shortTitle || undefined;
      pending.updatedAt = Date.now();
      return { changed: true, text: `Updated pending advice ${adviceId}.`, oldNote };
    }
    const queued = this.pendingAccess?.list().find(item => item.adviceId === adviceId);
    if (queued && this.pendingAccess!.revise(adviceId, note, shortTitle)) {
      // This note was already routed to a queue. Its new text belongs in the
      // delivered history too, even if the user later dismisses that queue item.
      const key = advisorNoteDedupeKey(note);
      this.#deliveredNoteSeverities.set(key, Math.max(
        this.#deliveredNoteSeverities.get(key) ?? 0, advisorSeverityRank(queued.severity),
      ));
      return { changed: true, text: `Updated queued advice ${adviceId}.` };
    }
    return this.#notPending();
  }

  withdraw(adviceId: string): { changed: boolean; text: string; withdrawnNote?: string } {
    const index = this.#deferredNotes.findIndex(item => item.adviceId === adviceId);
    if (index >= 0) {
      const [removed] = this.#deferredNotes.splice(index, 1);
      return { changed: true, text: `Withdrew pending advice ${adviceId}.`, withdrawnNote: removed?.note };
    }
    if (this.pendingAccess?.withdraw(adviceId)) {
      return { changed: true, text: `Withdrew queued advice ${adviceId}.` };
    }
    return this.#notPending();
  }

  #notPending(): { changed: false; text: string } {
    return {
      changed: false,
      text: "No editable advice with that ID. It may have been handed to Pi or removed; nothing was changed. Handed-off messages cannot be recalled.",
    };
  }

  /** A bounded reminder, not another transcript or an instruction to always comment. */
  pendingSummary(): string | undefined {
    const pending = this.pendingAdvice();
    if (pending.length === 0) return undefined;
    const lines = pending.slice(0, 3).map(item => {
      const preview = item.note.replace(/\s+/g, " ").slice(0, 180);
      const title = item.shortTitle ? ` “${item.shortTitle}”` : "";
      const age = item.createdAt === undefined ? "" : `, ${Math.max(0, Math.floor((Date.now() - item.createdAt) / 1000))}s old`;
      return `${item.adviceId} (${item.severity ?? "nit"}, ${item.status}${age})${title}: ${JSON.stringify(preview)}`;
    });
    return [
      "### Your pending advice",
      ...lines,
      ...(pending.length > lines.length ? [`${pending.length - lines.length} more; pending_advice lists them.`] : []),
      "These are still editable. New evidence may resolve an earlier concern; revise_advice or withdraw_advice can update it before handoff.",
    ].join("\n");
  }

  /** Clear per-session state at a genuine conversation reset. */
  resetDeliveredNotes(): void {
    this.#deliveredNoteSeverities.clear();
    this.#reviewing = false;
    this.#deferredNotes = [];
  }

  /** Returns an ID only for accepted advice, whether deferred or routed to the host. */
  submit(note: string, severity: AdvisorSeverity | undefined, shortTitle?: string, updateOnId?: string): { text: string; delivered: boolean; adviceId?: string } {
    const key = advisorNoteDedupeKey(note);
    if ((this.#deliveredNoteSeverities.get(key) ?? 0) >= advisorSeverityRank(severity)) {
      return { text: "Duplicate advice ignored.", delivered: false };
    }
    const existing = this.#deferredNotes.find(item => advisorNoteDedupeKey(item.note) === key);
    const now = Date.now();
    const record: PendingAdvisorNote = existing ?? { adviceId: randomUUID(), note, severity, shortTitle, updateOnId, createdAt: now, updatedAt: now };
    if (existing && advisorSeverityRank(severity) > advisorSeverityRank(existing.severity)) existing.severity = severity;
    if (existing && shortTitle !== undefined) existing.shortTitle = shortTitle || undefined;
    if (existing && updateOnId !== undefined) existing.updateOnId = updateOnId;
    this.#trackedNotes.set(record.adviceId, { ...record });

    if (this.#reviewing && severity !== "blocker") {
      if (!existing) this.#deferredNotes.push(record);
      return {
        text: `Deferred advice ${record.adviceId}. It remains editable until review completes (or while queued in the inbox).\n\n${this.formatQueueSnapshot()}`,
        delivered: false,
        adviceId: record.adviceId,
      };
    }
    const delivered = this.#deliver(record);
    if (existing && delivered) this.#deferredNotes = this.#deferredNotes.filter(item => item !== existing);
    return {
      text: delivered ? `Recorded advice ${record.adviceId}.\n\n${this.formatQueueSnapshot()}` : `Duplicate advice ignored.\n\n${this.formatQueueSnapshot()}`,
      delivered,
      ...(delivered ? { adviceId: record.adviceId } : {}),
    };
  }

  #deliver(note: PendingAdvisorNote): boolean {
    const key = advisorNoteDedupeKey(note.note);
    const rank = advisorSeverityRank(note.severity);
    if (rank <= (this.#deliveredNoteSeverities.get(key) ?? 0)) return false;
    this.onAdvice({ ...note });
    this.#deliveredNoteSeverities.set(key, rank);
    return true;
  }

  /** Mark a note as genuinely handed off to the primary agent's stream. */
  markStreamed(adviceId: string, note?: PendingAdvisorNote): void {
    const existing = note ?? this.#trackedNotes.get(adviceId);
    if (existing) {
      this.#streamedHistory.set(adviceId, { ...existing });
    }
  }
}
