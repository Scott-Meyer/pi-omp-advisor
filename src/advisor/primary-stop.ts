import { randomUUID } from "node:crypto";

/** A foreground call in Pi's tool lifecycle, including its execution preflight. */
export interface PrimaryToolActivity {
  /** Unique per execution, even if a provider later reuses a toolCallId. */
  targetId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  startedAt: number;
}

export type StopAvailability = "ready" | "disabled" | "idle" | "parallel_tools" | "ambiguous_tools" | "already_aborting" | "stop_pending";
export interface CurrentToolResult {
  status: StopAvailability;
  tool?: PrimaryToolActivity;
  activeCount: number;
}
export interface StopRequestResult {
  requested: boolean;
  status: StopAvailability | "requested" | "stale_target" | "invalid_reason" | "failed";
  message: string;
  requestId?: string;
}
export interface PrimaryStopAccess {
  currentTool(): CurrentToolResult;
  requestStop(targetId: string, reason: string, model?: string): StopRequestResult;
}
export interface StopReceipt {
  requestId: string;
  advisor?: string;
  /** Advisor route that generated the stop request. */
  model?: string;
  reason: string;
  target: PrimaryToolActivity;
  requestedAt: number;
  toolEndedAt?: number;
  toolIsError?: boolean;
  abortSignalObserved?: boolean;
  targetCompletionAmbiguous?: boolean;
  failure?: string;
  settledAt?: number;
}
export interface PrimaryStopHost {
  enabled(): boolean;
  isIdle(): boolean;
  isAborting(): boolean;
  /** Persist and display the reason before requesting the side effect. */
  recordRequest(receipt: StopReceipt): void;
  /** Pi's supported operation aborts the active turn, not an individual process. */
  abort(): void;
}

/**
 * Exact-target, single-request cancellation gate. It owns no processes and
 * cannot affect detached jobs. Only a sole in-flight foreground call is eligible;
 * the caller still owns the judgment about whether stopping is warranted.
 */
export class PrimaryStopController {
  #tools = new Map<string, { target: PrimaryToolActivity; count: number }>();
  // End events carry only the provider ID, so overlapping reuse cannot be
  // disambiguated. Fail closed for the rest of the run, even after those ends.
  #ambiguousIds = new Set<string>();
  #pending?: StopReceipt;

  constructor(private readonly host: PrimaryStopHost) {}

  toolStarted(activity: Omit<PrimaryToolActivity, "targetId">): PrimaryToolActivity {
    const target = { ...activity, targetId: randomUUID() };
    const active = this.#tools.get(activity.toolCallId);
    if (active) {
      active.count++;
      this.#ambiguousIds.add(activity.toolCallId);
      if (this.#pending?.target.targetId === active.target.targetId) this.#pending.targetCompletionAmbiguous = true;
    } else {
      this.#tools.set(activity.toolCallId, { target, count: 1 });
    }
    return { ...target };
  }

  toolEnded(toolCallId: string, isError: boolean, abortSignalObserved: boolean): void {
    const active = this.#tools.get(toolCallId);
    if (!active) return;
    if (--active.count === 0) this.#tools.delete(toolCallId);
    if (!this.#ambiguousIds.has(toolCallId) && this.#pending?.target.targetId === active.target.targetId) {
      this.#pending.toolEndedAt = Date.now();
      this.#pending.toolIsError = isError;
      this.#pending.abortSignalObserved = abortSignalObserved;
    }
  }

  currentTool(): CurrentToolResult {
    const activeCount = [...this.#tools.values()].reduce((count, active) => count + active.count, 0);
    if (!this.host.enabled()) return { status: "disabled", activeCount };
    if (this.#pending) return { status: "stop_pending", activeCount };
    if (this.#ambiguousIds.size > 0) return { status: "ambiguous_tools", activeCount };
    if (this.host.isIdle() || activeCount === 0) return { status: "idle", activeCount };
    if (this.host.isAborting()) return { status: "already_aborting", activeCount };
    if (activeCount !== 1) return { status: "parallel_tools", activeCount };
    return { status: "ready", tool: { ...this.#tools.values().next().value!.target }, activeCount };
  }

  requestStop(targetId: string, reason: string, advisor?: string, model?: string): StopRequestResult {
    const text = reason.trim();
    if (!text || text.length > 1000) {
      return { requested: false, status: "invalid_reason", message: "Give a concrete reason of 1–1000 characters. No cancellation requested." };
    }
    const current = this.currentTool();
    if (current.status !== "ready") {
      return { requested: false, status: current.status, message: `Cannot request a stop: ${current.status}. No cancellation requested.` };
    }
    if (current.tool!.targetId !== targetId) {
      return { requested: false, status: "stale_target", message: "That tool call is no longer the sole in-flight call. A stale request cannot stop a different operation." };
    }
    // No await between target validation, latching, audit, and cancellation.
    // Reentrant or competing advisors cannot issue another request this run.
    const receipt: StopReceipt = {
      requestId: randomUUID(), advisor, model, reason: text,
      target: current.tool!, requestedAt: Date.now(),
    };
    this.#pending = receipt;
    try {
      this.host.recordRequest({ ...receipt, target: { ...receipt.target } });
      this.host.abort();
      return {
        requested: true, status: "requested", requestId: receipt.requestId,
        message: "Cancellation requested for the active primary turn containing that tool. This is not confirmation of termination or rollback. Detached jobs are unaffected; the primary is not automatically restarted.",
      };
    } catch (error) {
      receipt.failure = error instanceof Error ? error.message : String(error);
      return { requested: false, status: "failed", requestId: receipt.requestId, message: "The stop request failed while recording or requesting cancellation. Do not assume the operation stopped; the request remains latched until the run settles." };
    }
  }

  /** Observe settlement separately from request acceptance; do not infer rollback. */
  settled(): StopReceipt | undefined {
    const receipt = this.#pending;
    this.reset();
    return receipt ? { ...receipt, target: { ...receipt.target }, settledAt: Date.now() } : undefined;
  }

  /** Session changes invalidate every earlier target and stop receipt. */
  reset(): void {
    this.#tools.clear();
    this.#ambiguousIds.clear();
    this.#pending = undefined;
  }
}

export function formatStopReceipt(receipt: StopReceipt): string {
  const outcome = receipt.failure
    ? `Request failed: ${receipt.failure}`
    : receipt.targetCompletionAmbiguous
      ? "The primary run settled; target completion is ambiguous because overlapping calls reused its tool-call ID."
      : receipt.toolEndedAt === undefined
        ? "The primary run settled; no completion event for the targeted call was observed."
        : `The targeted call ended ${receipt.toolIsError ? "with a tool error" : "without a tool error"}; an abort signal was ${receipt.abortSignalObserved ? "observed" : "not observed"} at completion.`;
  return [
    `Runtime stop receipt ${receipt.requestId}`,
    `Target: ${receipt.target.toolName} (${receipt.target.toolCallId}; execution ${receipt.target.targetId})`,
    `Advisor reason: ${receipt.reason}`,
    outcome,
    "This records a cancellation request and observed events, not proof of rollback or a request to resume. Detached jobs are not controlled by this request.",
  ].join("\n");
}
