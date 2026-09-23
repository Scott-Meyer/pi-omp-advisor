import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Cumulative SDK-normalized usage for one advisor runtime, independent of history. */
export interface AdvisorUsageStatus {
  /** Agent turn attempts, including failures before a response; not HTTP retries. */
  modelRequests: number;
  /** Final assistant messages, including SDK-generated failure responses. */
  modelResponses: number;
  /** Requested tool calls, not necessarily executed/successful calls. */
  toolRequests: number;
  toolRequestsByName: Record<string, number>;
  /** input excludes cache reads/writes; output already includes reported reasoning. */
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
  responsesWithUsage: number;
  /** Responses with a positive SDK cost estimate; zero pricing is ambiguous. */
  responsesWithCost: number;
  estimatedCostUsd: number;
}

export interface AdvisorUsageConnection {
  readonly completedResponses: number;
  readonly lastResponse: Pick<AssistantMessage, "stopReason" | "errorMessage"> | undefined;
  dispose(): void;
}

type EventSource = { subscribe(listener: (event: AgentEvent) => void): () => void };
const finiteCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Listen once per live Agent. Finalized assistant events are the accounting
 * boundary: message_update, turn_end and retained-history reads add nothing.
 * Keep this ledger when replacing an Agent; detach the old one after it idles.
 * SDK/provider-internal retries and usage they don't report are not observable.
 */
export class AdvisorUsageLedger {
  #status: AdvisorUsageStatus = {
    modelRequests: 0, modelResponses: 0, toolRequests: 0, toolRequestsByName: {},
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    responsesWithUsage: 0, responsesWithCost: 0, estimatedCostUsd: 0,
  };

  snapshot(): AdvisorUsageStatus {
    return { ...this.#status, tokens: { ...this.#status.tokens }, toolRequestsByName: { ...this.#status.toolRequestsByName } };
  }

  connect(source: EventSource): AdvisorUsageConnection {
    let completedResponses = 0;
    let lastResponse: AdvisorUsageConnection["lastResponse"];
    const dispose = source.subscribe(event => {
      if (event.type === "turn_start") this.#status.modelRequests++;
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message;
      completedResponses++;
      lastResponse = { stopReason: message.stopReason, errorMessage: message.errorMessage };
      this.#status.modelResponses++;
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        this.#status.toolRequests++;
        const counts = this.#status.toolRequestsByName;
        // defineProperty also handles tool names such as __proto__ safely.
        Object.defineProperty(counts, block.name, { value: (Object.hasOwn(counts, block.name) ? counts[block.name]! : 0) + 1, enumerable: true, configurable: true });
      }
      const usage = message.usage;
      // Some hosts/providers use a zero-filled Usage when usage is absent,
      // especially synthetic errors. Zero cannot establish that work was free.
      const keys = ["input", "cacheRead", "cacheWrite", "output"] as const;
      if (usage && keys.every(key => finiteCount(usage[key])) && keys.some(key => usage[key] > 0)) {
        this.#status.responsesWithUsage++;
        for (const key of keys) this.#status.tokens[key] += usage[key];
      }
      if (finiteCount(usage?.cost?.total) && usage.cost.total > 0) {
        this.#status.responsesWithCost++;
        this.#status.estimatedCostUsd += usage.cost.total;
      }
    });
    return {
      get completedResponses() { return completedResponses; },
      get lastResponse() { return lastResponse; },
      dispose,
    };
  }
}

/** Human-only detail; never included in the advisor's model context. */
export function formatAdvisorUsage(usage: AdvisorUsageStatus): string {
  const coverage = (count: number) => count === 0 ? "unavailable" : count < usage.modelResponses ? `partial ${count}/${usage.modelResponses} responses` : `${count}/${usage.modelResponses} responses`;
  const tokens = usage.responsesWithUsage === 0 ? "tokens unavailable" :
    `tokens (${coverage(usage.responsesWithUsage)}): uncached input ${usage.tokens.input}, cache-read ${usage.tokens.cacheRead}, cache-write ${usage.tokens.cacheWrite}, output ${usage.tokens.output} (includes reported reasoning)`;
  const cost = usage.responsesWithCost === 0 ? "SDK cost estimate unavailable (missing/zero pricing or usage)" :
    `SDK/provider cost estimate ~$${usage.estimatedCostUsd.toFixed(6)} (${coverage(usage.responsesWithCost)}; not an invoice, pricing may be incomplete)`;
  return `since runtime start: ${usage.modelRequests} model attempts / ${usage.modelResponses} responses, ${usage.toolRequests} tool requests; ${tokens}; ${cost}; provider-internal retries/unreported usage not included`;
}
