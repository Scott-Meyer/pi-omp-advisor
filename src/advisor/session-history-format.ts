/**
 * Ported from oh-my-pi `src/session/session-history-format.ts` (npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`) — the exact markdown transcript
 * serializer used to build the advisor's rendered context
 * (`ADVISOR_RENDER_OPTIONS` in upstream `delta-split.ts`:
 * `{ includeToolIntent: true, watchedRoles: true, expandPrimaryContext: true,
 * expandEditDiffs: true }`). Algorithm is unchanged; only type imports are
 * switched to pi's own message shapes (`@earendil-works/pi-agent-core`,
 * `@earendil-works/pi-ai`), and message kinds with no pi equivalent are
 * dropped rather than approximated — see ../../PROVENANCE.md items 6.
 *
 * pi has no `developer` role, no `pythonExecution`, `fileMention`, or
 * `hookMessage` message kinds, so those branches from upstream are omitted
 * (dead code in this host, not a behavior change for anything pi can emit).
 * pi's `bashExecution`, `custom`, `branchSummary`, `compactionSummary` map
 * directly onto upstream's message kinds of the same name.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

export interface HistoryFormatOptions {
  /** Optional H1 prepended to the transcript. */
  title?: string;
  /** Render assistant thinking blocks (default: elided). */
  includeThinking?: boolean;
  /** Render tool intent comment before tool call lines. */
  includeToolIntent?: boolean;
  /** Render watched-session roles as inline `**agent**:` / `**user**:` labels (collapsing consecutive same-role messages) instead of `## ` headings, so a primary transcript embedded inside an advisor turn stays visually distinct. */
  watchedRoles?: boolean;
  /**
   * Expand the primary agent's injected constraint context verbatim instead
   * of a truncated one-liner, wrapped in a `<primary-context>` tag. See
   * PROVENANCE.md item 6 — `PRIMARY_CONTEXT_CUSTOM_TYPES` is currently
   * empty pending confirmation of pi's own custom-type names, so this flag
   * is a no-op until that's filled in; every custom message renders as a
   * one-liner in the meantime (matches upstream's non-allowlisted path).
   */
  expandPrimaryContext?: boolean;
  /**
   * Append the full unified diff (from a tool result's `details.diff`)
   * below edit tool lines, instead of just the path.
   */
  expandEditDiffs?: boolean;
  /**
   * Chunked rendering support (unused by pi-omp-advisor's single-block render
   * today, kept for API parity / a future multi-message chunk renderer —
   * see PROVENANCE.md item 3).
   */
  toolResultIndex?: ReadonlyMap<string, ToolResultMessage>;
  consumedToolCallIds?: Set<string>;
  watchedRoleState?: { lastLabel: string | undefined };
}

/** Max length of the primary-arg summary inside `→ tool(...)` lines. */
const PRIMARY_ARG_MAX = 120;

/** Per-tool preference order for the most informative scalar argument. */
const PRIMARY_ARG_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "cmd",
  "pattern",
  "url",
  "query",
  "prompt",
  "assignment",
  "note",
  "message",
  "op",
  "name",
  "id",
] as const;

function oneLine(text: string, max = PRIMARY_ARG_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatExecutionSourcePreview(source: string): string {
  return oneLine(source);
}

function contentToText(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else parts.push("[image]");
  }
  return parts.join("\n");
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function primaryArgValue(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === "string")) {
    return value.join(", ");
  }
  return "";
}

/** Pick the most informative scalar argument of a tool call. */
export function formatToolCallPrimaryArg(name: string, args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  // Advisor note is the most informative summary; preserve severity too.
  if (name === "advise") {
    const note = typeof args.note === "string" ? args.note : "";
    const severity = typeof args.severity === "string" ? args.severity : "";
    if (note && severity) return oneLine(`${severity}: ${note}`);
    if (note) return oneLine(note);
    if (severity) return oneLine(severity);
  }
  if (name === "grep") {
    const pattern = primaryArgValue(args.pattern);
    const paths = primaryArgValue(args.path) || primaryArgValue(args.paths);
    if (pattern && paths) return oneLine(`${pattern} @ ${paths}`);
    if (pattern) return oneLine(pattern);
    if (paths) return oneLine(paths);
  }
  if (name === "glob" || name === "find") {
    const paths = primaryArgValue(args.path) || primaryArgValue(args.paths);
    if (paths) return oneLine(paths);
  }
  for (const key of PRIMARY_ARG_KEYS) {
    const value = args[key];
    const summary = primaryArgValue(value);
    if (summary) return oneLine(summary);
  }
  // Fallback: first non-empty string arg, then a compact JSON of the args.
  const rest: Record<string, unknown> = {};
  let restCount = 0;
  for (const key in args) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return oneLine(value);
    rest[key] = value;
    restCount++;
  }
  if (restCount === 0) return "{}";
  try {
    return oneLine(JSON.stringify(rest));
  } catch {
    return "";
  }
}

export function formatToolResultErrorPreview(content: string | readonly (TextContent | ImageContent)[]): string {
  return oneLine(contentToText(content).split("\n", 1)[0] ?? "");
}

/**
 * Wrap a diff body in a backtick fence sized to outlast the longest
 * backtick run inside it, so a diff that touches markdown can't break out
 * of the fence.
 */
function fenceDiff(diff: string): string {
  const longest = diff.match(/`+/g)?.reduce((m, run) => Math.max(m, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}diff\n${diff}\n${fence}`;
}

/** One line per tool call: `→ read(src/foo.ts:50-80) ⇒ ok · 31 lines`. */
function toolCallLine(
  name: string,
  args: Record<string, unknown> | undefined,
  result: ToolResultMessage | undefined,
  includeToolIntent?: boolean,
  expandEditDiffs?: boolean,
): string {
  const head = `→ ${name}(${formatToolCallPrimaryArg(name, args)})`;
  let base: string;
  if (!result) {
    base = `${head} ⇒ pending`;
  } else {
    const text = contentToText(result.content);
    const lines = lineCount(text);
    const count = `${lines} ${lines === 1 ? "line" : "lines"}`;
    if (result.isError) {
      const firstLine = formatToolResultErrorPreview(result.content);
      base = firstLine ? `${head} ⇒ error · ${count} — ${firstLine}` : `${head} ⇒ error · ${count}`;
    } else {
      base = `${head} ⇒ ok · ${count}`;
    }
  }

  if (expandEditDiffs) {
    const diff = (result?.details as { diff?: unknown } | undefined)?.diff;
    if (typeof diff === "string" && diff.trim()) {
      base = `${base}\n${fenceDiff(diff)}`;
    }
  }

  // pi tools don't carry a separate "intent" field the way omp's do; this
  // hook is kept for API parity but is currently always a no-op.
  void includeToolIntent;
  return base;
}

/** One line for a user-initiated `!` bash execution. Always attributed to
 *  the user: pi's `bashExecution` role never carries agent-run commands
 *  (the model's bash goes through `toolCall`), so the `user-` prefix makes
 *  provenance explicit for the advisor regardless of render mode. */
function bashExecutionLine(command: string, output: string, exitCode: number | undefined, cancelled: boolean): string {
  const status = cancelled ? "cancelled" : exitCode !== undefined && exitCode !== 0 ? `error · exit ${exitCode}` : "ok";
  const lines = lineCount(output);
  const sourcePreview = formatExecutionSourcePreview(command);
  return `→ user-bash! ${sourcePreview} ⇒ ${status} · ${lines} ${lines === 1 ? "line" : "lines"}`;
}

/** One-liner for custom messages: `[type] body…`. */
function customOneLiner(customType: string, content: string | readonly (TextContent | ImageContent)[]): string {
  return `[${customType}] ${oneLine(contentToText(content))}`;
}

/**
 * Format a session's message array as a concise markdown transcript. Same
 * algorithm as upstream `formatSessionHistoryMarkdown`.
 */
export function formatSessionHistoryMarkdown(messages: AgentMessage[], opts?: HistoryFormatOptions): string {
  const lines: string[] = [];
  if (opts?.title) {
    lines.push(`# ${opts.title}`, "");
  }

  let resultsByCallId = opts?.toolResultIndex;
  if (!resultsByCallId) {
    const local = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") local.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
    }
    resultsByCallId = local;
  }
  const consumed = opts?.consumedToolCallIds ?? new Set<string>();
  let lastWatchedLabel: string | undefined = opts?.watchedRoleState?.lastLabel;

  const pushWatchedRole = (label: string, body: string): void => {
    if (lastWatchedLabel === label) {
      lines.push(body, "");
    } else {
      lines.push(label, body, "");
      lastWatchedLabel = label;
    }
  };

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text = contentToText(msg.content);
        if (!text.trim()) break;
        if (opts?.watchedRoles) {
          const label = "**user**:";
          if (lastWatchedLabel === label) {
            lines.push(text, "");
          } else {
            lines.push(label, text, "");
            lastWatchedLabel = label;
          }
        } else {
          lines.push("## user", "", text, "");
        }
        break;
      }
      case "assistant": {
        const assistantMsg = msg as AssistantMessage;
        const body: string[] = [];
        for (const block of assistantMsg.content) {
          if (block.type === "text") {
            if (block.text.trim()) body.push(block.text);
          } else if (block.type === "toolCall") {
            const result = resultsByCallId.get(block.id);
            if (result) consumed.add(block.id);
            body.push(
              toolCallLine(block.name, block.arguments, result, opts?.includeToolIntent, opts?.expandEditDiffs),
            );
          } else if (opts?.includeThinking && block.type === "thinking" && block.thinking.trim()) {
            body.push(`_thinking:_ ${block.thinking}`);
          }
        }
        if (body.length === 0) break;
        if (opts?.watchedRoles) {
          const label = "**agent**:";
          if (lastWatchedLabel === label) {
            lines.push(...body, "");
          } else {
            lines.push(label, ...body, "");
            lastWatchedLabel = label;
          }
        } else {
          lines.push("## assistant", "", ...body, "");
        }
        break;
      }
      case "toolResult": {
        const toolResult = msg as ToolResultMessage;
        if (consumed.has(toolResult.toolCallId)) break;
        lines.push(
          toolCallLine(toolResult.toolName, undefined, toolResult, opts?.includeToolIntent, opts?.expandEditDiffs),
          "",
        );
        lastWatchedLabel = undefined;
        break;
      }
      case "bashExecution": {
        const bashMsg = msg as AgentMessage & {
          command: string;
          output: string;
          exitCode: number | undefined;
          cancelled: boolean;
          excludeFromContext?: boolean;
        };
        if (bashMsg.excludeFromContext) break;
        const bashLine = bashExecutionLine(bashMsg.command, bashMsg.output, bashMsg.exitCode, bashMsg.cancelled);
        if (opts?.watchedRoles) {
          pushWatchedRole("**user**:", bashLine);
        } else {
          lines.push(bashLine, "");
          lastWatchedLabel = undefined;
        }
        break;
      }
      case "custom": {
        const custom = msg as AgentMessage & {
          customType: string;
          content: string | (TextContent | ImageContent)[];
          display: boolean;
        };
        if (custom.display === false) break;
        lines.push(customOneLiner(custom.customType, custom.content), "");
        lastWatchedLabel = undefined;
        break;
      }
      case "branchSummary": {
        const branchMsg = msg as AgentMessage & { fromId: string; summary: string };
        lines.push(`[branch] from ${branchMsg.fromId}: ${oneLine(branchMsg.summary)}`, "");
        lastWatchedLabel = undefined;
        break;
      }
      case "compactionSummary": {
        const compactMsg = msg as AgentMessage & { summary: string };
        lines.push(`[compaction] ${oneLine(compactMsg.summary)}`, "");
        lastWatchedLabel = undefined;
        break;
      }
    }
  }

  if (opts?.watchedRoleState) {
    opts.watchedRoleState.lastLabel = lastWatchedLabel;
  }

  return `${lines.join("\n").trim()}\n`;
}
