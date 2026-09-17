import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export const DEFAULT_ADVISOR_CONTEXT_TOKENS = 32_000;
export const MIN_ADVISOR_CONTEXT_TOKENS = 2_048;

const OMISSION = "\n[Content omitted by the advisor context budget.]\n";
const WINDOW_NOTICE = "This is a bounded recent context window. Older observations and investigation results may have expired; they have not been summarized. Shortened output is not evidence that the omitted content was absent. Pending advice is stored separately.";

export interface ContextWindowStatus {
  /** Estimates include the fixed system prompt, tool definitions and messages. */
  estimatedTokens: number;
  limitTokens: number;
  retainedMessages: number;
  trimmed: boolean;
  /** Whole-history resets performed at an update boundary. */
  resets: number;
}

export class AdvisorContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorContextBudgetError";
  }
}

export function estimateContextMessageTokens(message: AgentMessage): number {
  // The SDK estimator is heuristic, not a model-specific tokenizer. Include a
  // small per-message framing allowance rather than treating empty messages as free.
  return estimateTokens(message) + 12;
}

interface Unit {
  messages: AgentMessage[];
  originals: AgentMessage[];
  tokens: number;
}

/** Keep an assistant's calls and the following results together when evicting. */
function conversationUnits(messages: AgentMessage[], originals: AgentMessage[]): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const unit: Unit = { messages: [message], originals: [originals[i]!], tokens: 0 };
    if (message.role === "toolResult") {
      throw new AdvisorContextBudgetError("Cannot window a conversation containing an orphan tool result.");
    }
    if (message.role === "assistant") {
      const calls = message.content.filter(block => block.type === "toolCall");
      if (calls.length > 0) {
        const remaining = new Set(calls.map(call => call.id));
        if (remaining.size !== calls.length) throw new AdvisorContextBudgetError("Cannot window duplicate tool-call IDs in one exchange.");
        while (messages[i + 1]?.role === "toolResult") {
          i++;
          const result = messages[i] as ToolResultMessage;
          if (!remaining.delete(result.toolCallId)) {
            throw new AdvisorContextBudgetError("Cannot window an ambiguous tool-call/result group.");
          }
          unit.messages.push(result);
          unit.originals.push(originals[i]!);
        }
        if (remaining.size > 0) {
          throw new AdvisorContextBudgetError("Cannot window an incomplete tool-call/result group.");
        }
      }
    }
    unit.tokens = unit.messages.reduce((sum, item) => sum + estimateContextMessageTokens(item), 0);
    units.push(unit);
  }
  return units;
}

function shortenMessage(message: AgentMessage, limit: number): AgentMessage | undefined {
  // Never rewrite assistant calls, signatures, or reasoning blocks. Actual user
  // text and tool output can be shortened with an explicit omission marker.
  if (message.role !== "user" && message.role !== "toolResult") return undefined;
  const source = typeof message.content === "string" ? message.content : message.content.map(block =>
    block.type === "text" ? block.text : "[Image omitted by the advisor context budget.]",
  ).join("\n");
  const withText = (text: string): UserMessage | ToolResultMessage => message.role === "user"
    ? { ...message, content: text }
    : { ...message, content: [{ type: "text", text }] };
  const candidate = (characters: number) => {
    const head = Math.ceil(characters / 2);
    const tail = Math.floor(characters / 2);
    return withText(source.slice(0, head) + OMISSION + (tail > 0 ? source.slice(-tail) : ""));
  };
  if (estimateContextMessageTokens(candidate(0)) > limit) return undefined;
  let low = 0;
  let high = Math.max(0, source.length - 1);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateContextMessageTokens(candidate(mid)) <= limit) low = mid;
    else high = mid - 1;
  }
  return candidate(low);
}

/**
 * A bounded model-input memory, independent of pending-note state. History
 * grows with a stable cacheable prefix until the next update would overflow;
 * then all pre-update history expires at once. The current update and its tool
 * exchanges remain, so the advisor gets a fresh perspective without replaying
 * or summarizing the reasoning path that filled the old context.
 */
export class AdvisorContextWindow {
  // Originals and every shortened form share one lifecycle. Callers may
  // alternate raw Agent history and previously returned views.
  #retention = new WeakMap<AgentMessage, { current: AgentMessage; expired: boolean }>();
  #trimmed = false;
  #resets = 0;
  #lastCurrentStart = 0;
  #status: ContextWindowStatus;

  constructor(readonly requestedTokens = DEFAULT_ADVISOR_CONTEXT_TOKENS) {
    if (!Number.isSafeInteger(requestedTokens) || requestedTokens < MIN_ADVISOR_CONTEXT_TOKENS) {
      throw new AdvisorContextBudgetError(`contextTokens must be an integer of at least ${MIN_ADVISOR_CONTEXT_TOKENS}.`);
    }
    this.#status = { estimatedTokens: 0, limitTokens: requestedTokens, retainedMessages: 0, trimmed: false, resets: 0 };
  }

  get status(): ContextWindowStatus { return { ...this.#status }; }
  /** Current-update cursor in the most recent returned view. */
  get lastCurrentStart(): number { return this.#lastCurrentStart; }

  #stateFor(message: AgentMessage) {
    let state = this.#retention.get(message);
    if (!state) {
      state = { current: message, expired: false };
      this.#retention.set(message, state);
    }
    return state;
  }

  /**
   * A known interrupted run can end midway through a multi-call batch. Forget
   * that incomplete exchange atomically; do not invent results for calls that
   * never finished. Earlier history and complete exchanges are unaffected.
   */
  forgetInterruptedExchanges(messages: AgentMessage[], runStart: number): void {
    for (let i = runStart; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role !== "assistant") continue;
      const calls = message.content.filter(block => block.type === "toolCall");
      if (calls.length === 0) continue;
      const remaining = new Set(calls.map(call => call.id));
      let complete = remaining.size === calls.length;
      const exchange: AgentMessage[] = [message];
      while (messages[i + 1]?.role === "toolResult") {
        const result = messages[++i] as ToolResultMessage;
        if (!remaining.delete(result.toolCallId)) complete = false;
        exchange.push(result);
      }
      if (!complete || remaining.size > 0) {
        for (const item of exchange) this.#stateFor(item).expired = true;
        this.#trimmed = true;
      }
    }
  }

  trim(messages: AgentMessage[], fixedTokens = 0, modelContextWindow = 0, currentUpdateStart?: number): AgentMessage[] {
    // Leave reply/protocol headroom on small models. This is an estimated input
    // ceiling, not an exact provider-token guarantee or an output-token setting.
    const reserve = Math.min(8_192, Math.floor(modelContextWindow / 4));
    const limit = modelContextWindow > 0 ? Math.min(this.requestedTokens, modelContextWindow - reserve) : this.requestedTokens;
    const noticeTokens = estimateContextMessageTokens(this.notice());
    const budget = limit - fixedTokens - noticeTokens;
    if (budget < 128) throw new AdvisorContextBudgetError("The advisor's fixed instructions/tools leave no usable context budget. Increase contextTokens or reduce those instructions.");
    const explicitCurrent = currentUpdateStart === undefined
      ? undefined
      : new Set(messages.slice(Math.max(0, Math.min(currentUpdateStart, messages.length))));
    const originals = messages.filter(message => {
      if (this.#stateFor(message).expired) return false;
      // The Agent can retain a partial tool call from a failed provider stream;
      // those calls were never executed. They are not a tool exchange to keep.
      if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
        this.#stateFor(message).expired = true;
        this.#trimmed = true;
        return false;
      }
      return true;
    });
    const input = originals.map(message => this.#stateFor(message).current);
    const units = conversationUnits(input, originals);
    let currentUnitStart = explicitCurrent
      ? units.findIndex(unit => unit.originals.some(original => explicitCurrent.has(original)))
      : -1;
    if (explicitCurrent && currentUnitStart < 0) {
      // A cursor at the end means the prior transform is about to append the
      // update. Under pressure, clear all history before invoking that hook.
      currentUnitStart = units.length;
    } else if (currentUnitStart < 0) {
      // Direct users of AdvisorContextWindow can omit a cursor. Treat the last
      // contiguous user-message group and everything after it as one update.
      let latestUser = -1;
      for (let i = units.length - 1; i >= 0; i--) {
        if (units[i]!.messages[0]!.role === "user") { latestUser = i; break; }
      }
      currentUnitStart = latestUser;
      while (currentUnitStart > 0 && units[currentUnitStart - 1]!.messages[0]!.role === "user") currentUnitStart--;
    }
    if (currentUnitStart < 0) currentUnitStart = Math.max(0, units.length - 1);
    let tokens = units.reduce((sum, unit) => sum + unit.tokens, 0);
    const retained = new Set(units);
    // Reset atomically at the explicit update boundary. Removing only enough
    // old units to fit would shift the cached prefix on nearly every request.
    if (tokens > budget && currentUnitStart > 0) {
      for (let i = 0; i < currentUnitStart; i++) {
        const unit = units[i]!;
        retained.delete(unit);
        tokens -= unit.tokens;
        for (const original of unit.originals) this.#stateFor(original).expired = true;
      }
      this.#trimmed = true;
      this.#resets++;
    }
    if (tokens > budget) {
      const candidates = [...retained].flatMap(unit => unit.messages.map((message, index) => ({ unit, message, index })))
        .sort((a, b) => estimateContextMessageTokens(b.message) - estimateContextMessageTokens(a.message));
      for (const { unit, message, index } of candidates) {
        if (tokens <= budget) break;
        const before = estimateContextMessageTokens(message);
        const replacement = shortenMessage(message, Math.max(32, before - (tokens - budget)));
        if (!replacement) continue;
        const after = estimateContextMessageTokens(replacement);
        if (after >= before) continue;
        unit.messages[index] = replacement;
        const state = this.#stateFor(unit.originals[index]!);
        state.current = replacement;
        this.#retention.set(replacement, state);
        tokens -= before - after;
        this.#trimmed = true;
      }
    }
    if (tokens > budget) {
      throw new AdvisorContextBudgetError("The latest advisor exchange cannot fit the context budget without breaking tool-call pairing. No completed review can be inferred from this failure.");
    }
    const retainedUnits = units.filter(unit => retained.has(unit));
    const result = retainedUnits.flatMap(unit => unit.messages);
    const currentUnit = units[currentUnitStart];
    const retainedCurrentIndex = currentUnit ? retainedUnits.indexOf(currentUnit) : 0;
    this.#lastCurrentStart = retainedCurrentIndex < 0
      ? 0
      : retainedUnits.slice(0, retainedCurrentIndex).reduce((count, unit) => count + unit.messages.length, 0);
    this.#status = {
      estimatedTokens: fixedTokens + noticeTokens + tokens,
      limitTokens: limit,
      retainedMessages: result.length,
      trimmed: this.#trimmed,
      resets: this.#resets,
    };
    return result;
  }

  notice(): UserMessage {
    return { role: "user", content: WINDOW_NOTICE, timestamp: 0 };
  }
}

/** Provider-ready context gate exposed by OMP's Agent but not Pi's Agent type. */
interface ProviderContextLike {
  messages: AgentMessage[];
  systemPrompt?: string | string[];
  tools?: unknown[];
}

interface ProviderContextAgent {
  addBeforeModelCall?(callback: (
    context: ProviderContextLike,
    signal?: AbortSignal,
  ) => void | Promise<void>): () => void;
}

/**
 * OMP may retain an errored assistant plus synthetic results for calls that
 * completed before its stream failed. Its next provider context must omit the
 * whole failed exchange; Pi's raw-history behavior remains untouched.
 */
function withoutFailedProviderExchanges(messages: AgentMessage[]): AgentMessage[] {
  const retained: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant" || (message.stopReason !== "aborted" && message.stopReason !== "error")) {
      retained.push(message);
      continue;
    }
    const failedCalls = new Set(message.content.filter(block => block.type === "toolCall").map(block => block.id));
    while (messages[i + 1]?.role === "toolResult") {
      const result = messages[i + 1] as ToolResultMessage;
      if (!failedCalls.delete(result.toolCallId)) break;
      i++;
    }
  }
  return retained;
}

/** Install on the advisor only, using whichever public per-request hook the host exposes. */
export function installAdvisorContextWindow(agent: Agent, requestedTokens?: number): {
  window: AdvisorContextWindow;
  readonly interrupted: boolean;
  trimRetainedHistory(): void;
  dispose(): void;
} {
  const window = new AdvisorContextWindow(requestedTokens);
  let runSignal: AbortSignal | undefined;
  let runStart = agent.state.messages.length;
  const unsubscribe = agent.subscribe((event, signal) => {
    if (event.type === "agent_start") {
      // Pi supplies the signal here. OMP's single-argument subscription does
      // not, so its provider-context hook below captures the same run signal.
      runSignal = signal;
      runStart = agent.state.messages.length;
    }
  });
  const fixedTokens = (providerContext?: ProviderContextLike) => {
    const rawPrompt = providerContext?.systemPrompt ?? agent.state.systemPrompt;
    const prompt = Array.isArray(rawPrompt) ? rawPrompt.join("\n") : rawPrompt;
    const sourceTools = providerContext?.tools ?? agent.state.tools;
    // OMP's provider-context tool wrappers contain runner/session backrefs that
    // never go over the wire. Count only the descriptor fields a provider sees.
    const tools = sourceTools.map(tool => {
      const descriptor = tool as { name?: unknown; description?: unknown; parameters?: unknown; strict?: unknown };
      return {
        name: descriptor.name,
        description: descriptor.description,
        parameters: descriptor.parameters,
        ...(providerContext && descriptor.strict !== undefined ? { strict: descriptor.strict } : {}),
      };
    });
    return Math.ceil((prompt.length + JSON.stringify(tools).length) / 4) + 256;
  };
  const trim = (messages: AgentMessage[], currentStart?: number, fixed = fixedTokens()) =>
    window.trim(messages, fixed, agent.state.model?.contextWindow ?? 0, currentStart);

  const hasPiTransform = "transformContext" in agent;
  const priorTransform = agent.transformContext;
  let transform: NonNullable<Agent["transformContext"]> | undefined;
  let removeProviderHook: (() => void) | undefined;

  if (hasPiTransform) {
    transform = async (messages, signal) => {
      if (signal?.aborted) throw new AdvisorContextBudgetError("Advisor review was interrupted before the next model request.");
      // Trim original objects before Pi's cloning context event, so objects
      // evicted mid-review cannot reappear on the next tool-followup request.
      const retained = trim(messages, runStart);
      const transformedCurrentStart = window.lastCurrentStart;
      const transformed = priorTransform ? await priorTransform.call(agent, retained, signal) : retained;
      return [window.notice(), ...trim(transformed, transformedCurrentStart)];
    };
    agent.transformContext = transform;
  } else {
    // OMP keeps its Agent transform private, but exposes the final provider
    // context before every request. Transforming that request-local array keeps
    // tool-loop followups bounded without mutating or bypassing OMP's own
    // context transforms. The no-cursor form finds the latest user update in
    // this already-converted context; raw Agent history is still trimmed at the
    // completed update boundary below.
    const providerAgent = agent as Agent & ProviderContextAgent;
    if (!providerAgent.addBeforeModelCall) {
      unsubscribe();
      throw new AdvisorContextBudgetError("The host Agent exposes no supported per-request context hook.");
    }
    removeProviderHook = providerAgent.addBeforeModelCall(async (context, signal) => {
      runSignal = signal;
      if (signal?.aborted) throw new AdvisorContextBudgetError("Advisor review was interrupted before the next model request.");
      const fixed = fixedTokens(context);
      if (process.env.PI_ADVISOR_DEBUG === "1") {
        const rawPrompt = context.systemPrompt ?? "";
        const promptChars = (Array.isArray(rawPrompt) ? rawPrompt.join("\n") : rawPrompt).length;
        console.error(`[advisor:debug] OMP provider-context budget fixedTokens=${fixed} promptChars=${promptChars} requestedTokens=${requestedTokens ?? DEFAULT_ADVISOR_CONTEXT_TOKENS}`);
      }
      // OMP conversion retains assistant identities but clones user/tool-result
      // messages. A retention map shared across provider calls could therefore
      // expire half of a tool exchange and see the fresh clone as orphaned on
      // the next call. Each provider request gets an independent deterministic
      // view; the raw-history window below owns persistence across updates.
      const requestWindow = new AdvisorContextWindow(requestedTokens);
      const retained = requestWindow.trim(
        withoutFailedProviderExchanges(context.messages),
        fixed,
        agent.state.model?.contextWindow ?? 0,
      );
      context.messages = [requestWindow.notice(), ...retained];
    });
  }

  return {
    window,
    get interrupted() { return runSignal?.aborted === true; },
    // Called only after Agent.prompt settles, not while its event loop is live.
    trimRetainedHistory: () => {
      if (runSignal?.aborted) window.forgetInterruptedExchanges(agent.state.messages, runStart);
      const retainedHistory = hasPiTransform
        ? agent.state.messages
        : withoutFailedProviderExchanges(agent.state.messages);
      const retainedRunStart = hasPiTransform
        ? runStart
        : withoutFailedProviderExchanges(agent.state.messages.slice(0, runStart)).length;
      agent.state.messages = trim(retainedHistory, retainedRunStart);
    },
    dispose: () => {
      unsubscribe();
      removeProviderHook?.();
      if (transform && agent.transformContext === transform) agent.transformContext = priorTransform;
    },
  };
}
