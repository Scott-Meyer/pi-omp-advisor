import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import { activityContent, advisorObservationBatch, observationCards, toolCard, type ActivityCard, type ToolSource } from "./observations.ts";
import type { ToolPreview } from "./tool-preview.ts";

/** User is the transport role, not the author of the watched conversation. */
export interface AdvisorDeltaMessage {
  role: "user";
  content: TextContent[];
}
export interface RenderAdvisorDeltaOptions {
  wip: boolean;
  includeThinking: boolean;
  /** Calls from earlier batches still awaiting results, by tool-call ID. */
  earlierCalls?: ReadonlyMap<string, ToolCall>;
  /** Who provides each tool, as the host registered it. */
  toolSource?: ToolSource;
  /** The host's own collapsed preview of a tool result. */
  toolPreview?: ToolPreview;
}

/**
 * One chronological update. Each tool call is one card: when its result
 * arrives with only other tool activity in between (parallel calls, say), the
 * call's card becomes the completed card, much like the host's screen updates
 * it in place. When conversation arrived in between, or the call was in an
 * earlier batch, the completion appears where it arrived instead, so it never
 * looks finished before a correction that came first.
 */
export function renderAdvisorDeltaMessages(delta: AgentMessage[], opts: RenderAdvisorDeltaOptions): AdvisorDeltaMessage[] | null {
  const cards: ActivityCard[] = [];
  const open = new Map<string, { index: number; call: ToolCall }>();
  let lastConversation = -1;
  for (const message of delta) {
    if (message.role === "toolResult") {
      const local = open.get(message.toolCallId);
      if (local && local.call.name === message.toolName) {
        open.delete(message.toolCallId);
        if (lastConversation < local.index) cards[local.index] = toolCard(local.call, message, false, opts);
        else cards.push(toolCard(local.call, message, true, opts));
        continue;
      }
      const earlier = opts.earlierCalls?.get(message.toolCallId);
      const call = earlier?.name === message.toolName ? earlier : undefined;
      cards.push(toolCard(call, message, Boolean(call), opts));
      continue;
    }
    for (const card of observationCards(message, opts.includeThinking, opts)) {
      cards.push(card);
      if (card.kind === "conversation") lastConversation = cards.length - 1;
      else if (card.call) open.set(card.call.id, { index: cards.length - 1, call: card.call });
    }
  }
  return cards.length === 0 ? null : [{ role: "user", content: advisorObservationBatch(cards.map(activityContent), opts.wip) }];
}

/** Bound on remembered unresolved calls; the oldest are forgotten first. */
const MAX_OPEN_CALLS = 256;

/** Calls still awaiting results once `delta` has been seen, for pairing late completions. */
export function openToolCallsAfter(earlier: ReadonlyMap<string, ToolCall>, delta: AgentMessage[]): Map<string, ToolCall> {
  const open = new Map(earlier);
  for (const message of delta) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") { open.delete(block.id); open.set(block.id, block); }
    } else if (message.role === "toolResult") {
      open.delete(message.toolCallId);
    }
  }
  for (const id of open.keys()) {
    if (open.size <= MAX_OPEN_CALLS) break;
    open.delete(id);
  }
  return open;
}

export function joinAdvisorDeltaMessages(chunks: AdvisorDeltaMessage[]): string {
  return chunks.map(c => c.content.map(block => block.text).filter(Boolean).join("")).join("\n");
}
