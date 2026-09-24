/**
 * The advisor's view of the watched session: a readable skim, like someone
 * glancing over the human's shoulder. Conversation stays prominent; each tool
 * call is one short card (what was run, its status and size, the first line of
 * an error, and bounded edit/write diffs). Successful result bodies and ordinary
 * read-file contents stay out, keeping the advisor focused on the conversation
 * rather than a second copy of the primary's research.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { truncateDiffLines } from "./file-diff.ts";
import { formatToolCallPrimaryArg, formatToolResultErrorPreview } from "./session-history-format.ts";

export interface ActivityCard {
  title: string;
  body: string;
  /** Conversation cards mark a point in time a tool completion must not be moved before. */
  kind: "conversation" | "tool";
  /** The invocation this tool card shows, if known. */
  call?: ToolCall;
}

/** Previews for secondary reports: peer/extension messages, advisor notes, summaries. */
const SECONDARY_PREVIEW = 500;

function textContent(content: string | readonly (TextContent | ImageContent)[]): string {
  return typeof content === "string" ? content : content.map(block => block.type === "text" ? block.text : "[image]").join("\n");
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** One line, safe inside a heading. */
function label(value: unknown, maximum = 100): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  const safe = Array.from(line, character => ["\\", "`", "*", "<", ">", "#", "[", "]"].includes(character) ? `\\${character}` : character).join("");
  return safe.length > maximum ? `${safe.slice(0, maximum)}…` : safe;
}
function preview(text: string, maximum = SECONDARY_PREVIEW): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum)}… [${text.length - maximum} more characters not shown]`;
}
function lineCount(text: string): number {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}
function size(text: string): string {
  const lines = lineCount(text);
  return `${lines} ${lines === 1 ? "line" : "lines"}, ${text.length} characters`;
}
function backtickRun(text: string): number {
  return text.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
}
function fence(text: string, language = ""): string {
  const edge = "`".repeat(Math.max(3, backtickRun(text) + 1));
  return `${edge}${language}\n${text}\n${edge}`;
}
function code(text: string): string {
  const edge = "`".repeat(backtickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${edge}${pad}${text}${pad}${edge}`;
}
/** Other people's prose stays readable but cannot impersonate a card heading. */
function chat(text: string): string {
  return text.split("\n").map(line => line ? `> ${line}` : ">").join("\n");
}

/** What was run, in one line: the command, path, or most informative argument. */
function invocation(call: ToolCall): string {
  const args = call.arguments ?? {};
  let summary = formatToolCallPrimaryArg(call.name, args);
  if (call.name === "read" && typeof args.offset === "number") {
    summary += typeof args.limit === "number" ? ` · lines ${args.offset}–${args.offset + args.limit - 1}` : ` · from line ${args.offset}`;
  }
  return summary ? code(summary) : "";
}

function outcome(result: ToolResultMessage): string {
  const text = textContent(result.content);
  if (!result.isError) return `⇒ ok · ${size(text)}`;
  const first = formatToolResultErrorPreview(result.content);
  return `⇒ error · ${size(text)}${first ? ` — ${first}` : ""}`;
}

/** Who provides a tool, as Pi registered it: "built-in" or an extension/package name. */
export type ToolSource = (toolName: string) => string | undefined;

/**
 * One card for a tool call, its result, or both. `startedEarlier` marks a
 * completion shown apart from its invocation, where it arrived.
 */
export function toolCard(call: ToolCall | undefined, result: ToolResultMessage | undefined, startedEarlier = false, toolSource?: ToolSource): ActivityCard {
  const toolName = result?.toolName ?? call?.name;
  const source = typeof toolName === "string" ? label(toolSource?.(toolName)) : undefined;
  const name = `${label(toolName) ?? "unknown"}${source ? ` (${source})` : ""}`;
  const state = result ? (result.isError ? "error" : "completed") : "awaiting result";
  const parts: string[] = [];
  if (call) parts.push(invocation(call));
  if (result) {
    parts.push(outcome(result));
    const diff = record(result.details)?.diff;
    if (typeof diff === "string" && diff.trim()) parts.push(fence(truncateDiffLines(diff.trim()), "diff"));
  }
  return {
    title: `Tool · ${name} · ${state}${startedEarlier ? " · started earlier" : ""}`,
    body: parts.filter(Boolean).join("\n"),
    kind: "tool",
    call,
  };
}

function attribution(message: AgentMessage): string | undefined {
  const metadata = message as AgentMessage & { attribution?: unknown; steering?: unknown };
  const value = label(metadata.attribution);
  return value ? `${value}${metadata.steering === true ? " · steering" : ""}` : undefined;
}

/**
 * Pi labels an extension's message with its type, not with which extension
 * sent it, and its text is what the primary receives. Nothing here knows
 * particular extensions; only this advisor's own messages are recognized.
 */
function customTitle(message: AgentMessage & { customType: string; details?: unknown }): string {
  if (["advisor", "pi-omp-advisor"].includes(message.customType)) {
    const name = label(record(message.details)?.advisor);
    return name ? `Advisor · ${name}` : "Advisor";
  }
  return `Extension message · ${label(message.customType) ?? "unnamed"}`;
}

function advisorNoteCards(details: Record<string, unknown> | undefined): ActivityCard[] | undefined {
  if (!Array.isArray(details?.notes) || details.notes.length === 0) return undefined;
  const notes = details.notes.map(record);
  if (!notes.every(note => typeof note?.note === "string")) return undefined;
  return notes.map(note => {
    const title = ["Advisor", label(note!.advisor), label(note!.severity), note!.updateOnId ? "update" : undefined].filter(Boolean).join(" · ");
    const shortTitle = label(note!.shortTitle, 200);
    return { title, body: [shortTitle ? `**${shortTitle}**` : "", chat(preview(note!.note as string))].filter(Boolean).join("\n\n"), kind: "conversation" };
  });
}

/** Cards for one watched message, in order. Tool results are paired by the batch renderer. */
export function observationCards(message: AgentMessage, includeThinking: boolean, toolSource?: ToolSource): ActivityCard[] {
  const conversation = (title: string, body: string): ActivityCard => ({ title, body, kind: "conversation" });
  switch (message.role) {
    case "user": {
      const text = textContent(message.content);
      if (!text.trim()) return [];
      const source = attribution(message);
      // A Pi user-role message. Extensions can send these too, so it isn't proof a person typed it.
      return [conversation(`User message${source ? ` · ${source}` : ""}`, chat(text))];
    }
    case "assistant": {
      const cards: ActivityCard[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) cards.push(conversation("Primary", chat(block.text)));
        else if (block.type === "thinking" && includeThinking && block.thinking.trim()) cards.push(conversation("Primary · reasoning", chat(block.thinking)));
        else if (block.type === "toolCall") cards.push(toolCard(block, undefined, false, toolSource));
      }
      return cards;
    }
    case "toolResult": return [toolCard(undefined, message, false, toolSource)];
    case "custom": {
      // Hidden custom messages aren't on the human's screen, so they aren't on the advisor's either.
      if (message.display === false) return [];
      const details = record(message.details);
      if (["advisor", "pi-omp-advisor"].includes(message.customType)) {
        const notes = advisorNoteCards(details);
        if (notes) return notes;
      }
      return [conversation(customTitle(message), chat(preview(textContent(message.content))))];
    }
    case "bashExecution": {
      if (message.excludeFromContext) return [];
      const failed = message.exitCode !== undefined && message.exitCode !== 0;
      const status = message.cancelled ? "cancelled" : failed ? `error (exit ${message.exitCode})` : "completed";
      const command = formatToolCallPrimaryArg("bash", { command: message.command });
      return [conversation(`User · ! command · ${status}`, `${code(command)}\n⇒ ${size(message.output)}`)];
    }
    case "compactionSummary": return [conversation("Summary · compaction", chat(preview(message.summary)))];
    case "branchSummary": return [conversation("Summary · branch", chat(preview(message.summary)))];
    default: return [];
  }
}

const TITLE_PREFIX = "### ";
const BATCH_PREFIX = "## Watched conversation";
const BLOCK_SEPARATOR = "\n\n";

/** A heading block and a body block, so budgeting can shorten bodies and keep who said what. */
export function activityContent(card: ActivityCard): TextContent[] {
  return [
    { type: "text", text: TITLE_PREFIX + card.title + BLOCK_SEPARATOR },
    { type: "text", text: card.body + BLOCK_SEPARATOR },
  ];
}
export function advisorObservationContent(title: string, body: string): TextContent[] {
  return activityContent({ title, body, kind: "conversation" });
}
export function advisorObservationBatch(items: readonly TextContent[][], wip: boolean): TextContent[] {
  return [{ type: "text", text: BATCH_PREFIX + (wip ? " · in progress — more steps follow" : "") + BLOCK_SEPARATOR }, ...items.flat()];
}

/** Shorten card bodies under budget pressure without removing their headings. */
export function shortenAdvisorObservation(message: UserMessage, characters: number, omission: string): UserMessage | undefined {
  if (typeof message.content === "string" || message.content.some(block => block.type !== "text")) return undefined;
  const content = message.content as TextContent[];
  const start = content[0]?.text.startsWith(BATCH_PREFIX) ? 1 : 0;
  if (content.length <= start || (content.length - start) % 2 !== 0) return undefined;
  const cards: { title: TextContent; body: TextContent; allowance: number }[] = [];
  for (let i = start; i < content.length; i += 2) {
    if (!content[i]!.text.startsWith(TITLE_PREFIX)) return undefined;
    cards.push({ title: content[i]!, body: content[i + 1]!, allowance: 0 });
  }
  // Small bodies keep their full text; the largest absorb the cut.
  let remaining = Math.max(0, characters);
  const bySize = [...cards].sort((a, b) => a.body.text.length - b.body.text.length);
  for (let i = 0; i < bySize.length; i++) {
    const item = bySize[i]!;
    item.allowance = Math.min(item.body.text.length, Math.floor(remaining / (bySize.length - i)));
    remaining -= item.allowance;
  }
  return {
    ...message,
    content: [...content.slice(0, start), ...cards.flatMap(({ title, body, allowance }) => {
      if (allowance >= body.text.length) return [title, body];
      const head = Math.ceil(allowance / 2), tail = Math.floor(allowance / 2);
      return [title, { type: "text" as const, text: fence(body.text.slice(0, head) + omission + (tail ? body.text.slice(-tail) : "")) + BLOCK_SEPARATOR }];
    })],
  };
}
