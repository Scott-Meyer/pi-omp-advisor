/**
 * Remembers that the primary was stopped after its live AbortSignal disappears.
 * Owned by the primary session, not an advisor runtime: restarting an advisor
 * does not grant it permission to restart the primary.
 */
export class PrimaryInterruptionState {
  #suppressed = false;
  #stopWatching: (() => void) | undefined;

  get autoResumeSuppressed(): boolean { return this.#suppressed; }

  /** Observe the public signal at primary agent_start; this is not a resume. */
  watch(signal: AbortSignal | undefined): void {
    this.stopWatching();
    if (!signal) return;
    const onAbort = () => this.suppress();
    signal.addEventListener("abort", onAbort, { once: true });
    this.#stopWatching = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  }

  suppress(): void { this.#suppressed = true; }

  /** A new normal user prompt explicitly permits future advisor-driven turns. */
  resume(): void { this.#suppressed = false; }

  /** Detach on shutdown without undoing the user's stop for retiring advisors. */
  stopWatching(): void {
    this.#stopWatching?.();
    this.#stopWatching = undefined;
  }

  /** A genuinely new primary session starts with fresh interruption state. */
  reset(): void {
    this.stopWatching();
    this.resume();
  }
}
