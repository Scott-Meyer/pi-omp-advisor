/**
 * Ported from oh-my-pi `src/advisor/emission-guard.ts` (npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`). The filter and new-note allowance
 * follow upstream; pending-note revisions also register replacement text in
 * duplicate history without consuming that allowance. See ../../PROVENANCE.md.
 *
 * Per-session policy gate for advisor `advise()` calls.
 *
 * The advisor system prompt tells the watcher model:
 *
 * > at most one `advise` per update
 * > NEVER repeat advice you already gave, and NEVER send the same advice twice
 *
 * Real advisor models violate this in practice (upstream observed a session
 * with 309 `advise` calls covering 92 unique notes — mostly "Stop.", "No
 * issue; continue.", "Done." — flooding the primary transcript). The fix is
 * to make the rules load-bearing in code instead of prose: silently drop
 * duplicates, content-free self-talk, and over-budget calls at the
 * `enqueueAdvice` boundary so the primary stays clean even when the advisor
 * misbehaves.
 *
 * The tool does not expose the specific rejection reason: that can encourage
 * rephrasing the same useless note to bypass the filter. A rejected submission
 * gets a generic no-new-advice acknowledgment, with no editable receipt ID.
 */

/**
 * Case-insensitive, punctuation-folded normalization. Collapses every run of
 * non-letter / non-digit characters into a single space and trims, so
 * `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`, while
 * `"No issue; continue."` keys to `no issue continue`.
 *
 * Exported for tests.
 */
export function normalizeAdvisorNote(note: string): string {
  return note
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Normalized phrases the advisor occasionally emits that carry no concrete
 * actionable content. Each must be the output of {@link normalizeAdvisorNote}
 * so a single membership check covers every punctuation/casing variant
 * (`"Stop."`, `"stop"`, `"STOP!"`).
 *
 * The list is conservative — only short, content-free filler observed to
 * drive primary-transcript pollution upstream. A genuine `blocker` like
 * `"Stop: 'await' missing on writeStream.end() will lose buffered writes."`
 * does not match.
 */
const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
  // Self-stop noise — telling the agent to "stop" without a reason is useless.
  stop: true,
  "stop here": true,
  "stop now": true,
  halt: true,
  abort: true,
  // Completion self-talk — the agent already finished the task.
  done: true,
  "task done": true,
  "task complete": true,
  complete: true,
  finished: true,
  ok: true,
  okay: true,
  "ok done": true,
  // "Nothing to flag" — silence is the correct expression of "no concerns".
  "no issue": true,
  "no issues": true,
  "no issue continue": true,
  "no concerns": true,
  "no concern": true,
  "nothing to add": true,
  "nothing to flag": true,
  "nothing to report": true,
  "no notes": true,
  "no further input": true,
  "no further input needed": true,
  "no further input required": true,
  "no further watcher input": true,
  "no further watcher input needed": true,
  "no further advice": true,
  "no further advice needed": true,
  // Endorsements — equivalent to silence.
  lgtm: true,
  "looks good": true,
  "all good": true,
  "agent is on track": true,
  "agent on track": true,
  "on track": true,
  continue: true,
  "carry on": true,
};

/**
 * Bounds the dedupe history. Upstream's pathological session had 92 unique
 * notes; 4096 leaves headroom while staying tiny (≤ ~256 KB of normalized
 * strings even at long max).
 */
const DEFAULT_HISTORY_CAPACITY = 4096;

/**
 * Decides whether an advisor `advise()` call should reach the primary agent.
 *
 * Enforces — in this order — the noise filter, session-scoped exact-text
 * dedupe (FIFO-evicted at {@link DEFAULT_HISTORY_CAPACITY}), and a per-update
 * rate limit of one accepted note per advisor model prompt. Suppressed calls
 * never consume the per-update budget — a noise call doesn't burn the slot
 * for a real concern that follows in the same update.
 *
 * Retained across within-session context rebuilds; a new advisor session gets
 * a fresh guard. Per-update gate is cleared at the
 * start of every advisor prompt cycle via {@link AdvisorEmissionGuard.beginUpdate}.
 */
export class AdvisorEmissionGuard {
  static readonly DEFAULT_UPDATE_BUDGET = 3;
  #seen = new Set<string>();
  /** Insertion-order log to drive FIFO eviction without an extra Map. */
  #seenOrder: string[] = [];
  #acceptedThisUpdate = 0;
  readonly #capacity: number;
  readonly #updateBudget: number;

  constructor(opts: { capacity?: number; updateBudget?: number } = {}) {
    this.#capacity = opts.capacity ?? DEFAULT_HISTORY_CAPACITY;
    this.#updateBudget = opts.updateBudget ?? AdvisorEmissionGuard.DEFAULT_UPDATE_BUDGET;
  }

  /**
   * Drop all dedupe and per-update state when deliberately resetting the
   * advisor's conversation. A mere model-context rebuild retains this guard.
   */
  reset(): void {
    this.#seen.clear();
    this.#seenOrder.length = 0;
    this.#acceptedThisUpdate = 0;
  }

  /**
   * Clear the per-update rate-limit gate. Called right before each advisor
   * prompt invocation so the next advisor model cycle starts with a fresh
   * budget of notes.
   */
  beginUpdate(): void {
    this.#acceptedThisUpdate = 0;
  }

  /** Inspect the current review's used and total note allowance. */
  statusThisUpdate(): { used: number; total: number; remaining: number } {
    return {
      used: this.#acceptedThisUpdate,
      total: this.#updateBudget,
      remaining: Math.max(0, this.#updateBudget - this.#acceptedThisUpdate),
    };
  }

  /**
   * Diagnostic check evaluating whether a note is accepted, with specific
   * reason codes for rate limits vs deduplication/noise filtering.
   */
  check(note: string): {
    accepted: boolean;
    reason?: "empty" | "noise" | "duplicate" | "budget_exceeded";
    allowance?: { used: number; total: number };
  } {
    const key = normalizeAdvisorNote(note);
    if (!key) return { accepted: false, reason: "empty" };
    if (SUPPRESSED_NORMALIZED_PHRASES[key]) return { accepted: false, reason: "noise" };
    if (this.#seen.has(key)) return { accepted: false, reason: "duplicate" };
    if (this.#acceptedThisUpdate >= this.#updateBudget) {
      return {
        accepted: false,
        reason: "budget_exceeded",
        allowance: { used: this.#acceptedThisUpdate, total: this.#updateBudget },
      };
    }
    this.#acceptedThisUpdate++;
    this.remember(note);
    return {
      accepted: true,
      allowance: { used: this.#acceptedThisUpdate, total: this.#updateBudget },
    };
  }

  /**
   * Whether the proposed note should reach the primary. On `true` the gate
   * has already recorded the note (consumed the per-update budget and added
   * it to the dedupe history) — caller delivers the note. On `false` the
   * caller drops it.
   */
  accept(note: string): boolean {
    return this.check(note).accepted;
  }

  /** Remember a successful revision without consuming the new-note allowance. */
  remember(note: string): void {
    const key = normalizeAdvisorNote(note);
    if (!key || this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#seenOrder.push(key);
    if (this.#seenOrder.length > this.#capacity) {
      const stale = this.#seenOrder.shift();
      if (stale !== undefined) this.#seen.delete(stale);
    }
  }

  /** Forget a note that was discarded before delivery so it can be re-raised in a future review. */
  forget(note: string): void {
    const key = normalizeAdvisorNote(note);
    if (!key || !this.#seen.has(key)) return;
    this.#seen.delete(key);
    const idx = this.#seenOrder.indexOf(key);
    if (idx >= 0) this.#seenOrder.splice(idx, 1);
  }
}
