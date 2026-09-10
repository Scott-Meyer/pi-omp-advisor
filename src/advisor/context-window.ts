import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export const DEFAULT_ADVISOR_CONTEXT_TOKENS = 100_000;
export const MIN_ADVISOR_CONTEXT_TOKENS = 2_048;

const OMISSION = "\n[Content omitted by the advisor context budget.]\n";
const WINDOW_NOTICE = "This is a bounded recent context window. Older observations and investigation results may have expired; they have not been summarized. Shortened output is not evidence that the omitted content was absent. Pending advice is stored separately.";

export interface ContextWindowStatus {
  /** Estimates include the fixed system prompt, tool definitions and messages. */
  estimatedTokens: number;
  limitTokens: number;
  retainedMessages: number;
  trimmed: boolean;
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
 * A rolling model-input window, independent of pending-note state. Evicted or
 * shortened objects stay that way for this session, including repeated context
 * transforms inside one tool-using review. No summary carries the old narrative.
 */
export class AdvisorContextWindow {
  // Originals and every shortened form share one lifecycle. Callers may
  // alternate raw Agent history and previously returned views.
  #retention = new WeakMap<AgentMessage, { current: AgentMessage; expired: boolean }>();
  #trimmed = false;
  #status: ContextWindowStatus;

  constructor(readonly requestedTokens = DEFAULT_ADVISOR_CONTEXT_TOKENS) {
    if (!Number.isSafeInteger(requestedTokens) || requestedTokens < MIN_ADVISOR_CONTEXT_TOKENS) {
      throw new AdvisorContextBudgetError(`contextTokens must be an integer of at least ${MIN_ADVISOR_CONTEXT_TOKENS}.`);
    }
    this.#status = { estimatedTokens: 0, limitTokens: requestedTokens, retainedMessages: 0, trimmed: false };
  }

  get status(): ContextWindowStatus { return { ...this.#status }; }

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

  trim(messages: AgentMessage[], fixedTokens = 0, modelContextWindow = 0): AgentMessage[] {
    // Leave reply/protocol headroom on small models. This is an estimated input
    // ceiling, not an exact provider-token guarantee or an output-token setting.
    const reserve = Math.min(8_192, Math.floor(modelContextWindow / 4));
    const limit = modelContextWindow > 0 ? Math.min(this.requestedTokens, modelContextWindow - reserve) : this.requestedTokens;
    const noticeTokens = estimateContextMessageTokens(this.notice());
    const budget = limit - fixedTokens - noticeTokens;
    if (budget < 128) throw new AdvisorContextBudgetError("The advisor's fixed instructions/tools leave no usable context budget. Increase contextTokens or reduce those instructions.");
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
    let latestUser = -1;
    for (let i = units.length - 1; i >= 0; i--) {
      if (units[i]!.messages[0]!.role === "user") { latestUser = i; break; }
    }
    const last = units.length - 1;
    const lastRole = units[last]?.messages.at(-1)?.role;
    const required = new Set([latestUser, ...(lastRole === "user" || lastRole === "toolResult" ? [last] : [])]);
    let tokens = units.reduce((sum, unit) => sum + unit.tokens, 0);
    const retained = new Set(units);
    // Expire the oldest optional exchanges first. The current observation and
    // current tool exchange remain available for the next model response.
    for (let i = 0; i < units.length && tokens > budget; i++) {
      if (required.has(i)) continue;
      const unit = units[i]!;
      retained.delete(unit);
      tokens -= unit.tokens;
      for (const original of unit.originals) this.#stateFor(original).expired = true;
      this.#trimmed = true;
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
    const result = units.filter(unit => retained.has(unit)).flatMap(unit => unit.messages);
    this.#status = { estimatedTokens: fixedTokens + noticeTokens + tokens, limitTokens: limit, retainedMessages: result.length, trimmed: this.#trimmed };
    return result;
  }

  notice(): UserMessage {
    return { role: "user", content: WINDOW_NOTICE, timestamp: 0 };
  }
}

/** Install on the advisor only, using the SDK's public per-request context hook. */
export function installAdvisorContextWindow(agent: Agent, requestedTokens?: number): {
  window: AdvisorContextWindow;
  readonly interrupted: boolean;
  trimRetainedHistory(): void;
  dispose(): void;
} {
  const window = new AdvisorContextWindow(requestedTokens);
  let runSignal: AbortSignal | undefined;
  let runStart = 0;
  const unsubscribe = agent.subscribe((event, signal) => {
    if (event.type === "agent_start") {
      runSignal = signal;
      runStart = agent.state.messages.length;
    }
  });
  const priorTransform = agent.transformContext;
  const fixedTokens = () => Math.ceil((agent.state.systemPrompt.length + JSON.stringify(agent.state.tools.map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters,
  }))).length) / 4) + 256;
  const trim = (messages: AgentMessage[]) => window.trim(messages, fixedTokens(), agent.state.model?.contextWindow ?? 0);
  const transform: NonNullable<Agent["transformContext"]> = async (messages, signal) => {
    if (signal?.aborted) throw new AdvisorContextBudgetError("Advisor review was interrupted before the next model request.");
    // Trim original objects before the SDK's cloning context event, so objects
    // evicted mid-review cannot reappear on the next tool-followup request.
    const retained = trim(messages);
    const transformed = priorTransform ? await priorTransform.call(agent, retained, signal) : retained;
    return [window.notice(), ...trim(transformed)];
  };
  agent.transformContext = transform;
  return {
    window,
    get interrupted() { return runSignal?.aborted === true; },
    // Called only after Agent.prompt settles, not while its event loop is live.
    trimRetainedHistory: () => {
      if (runSignal?.aborted) window.forgetInterruptedExchanges(agent.state.messages, runStart);
      agent.state.messages = trim(agent.state.messages);
    },
    dispose: () => {
      unsubscribe();
      if (agent.transformContext === transform) agent.transformContext = priorTransform;
    },
  };
}
