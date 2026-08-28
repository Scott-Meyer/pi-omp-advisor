/**
 * Ported from oh-my-pi `src/advisor/delta-split.ts` (npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`) — renders one advisor delta as
 * MULTIPLE user-shaped messages, one per source message, instead of one
 * ever-growing block. Upstream's reason: provider prompt caches are
 * prefix-based, so a single message whose text keeps growing invalidates
 * the whole thing on every turn; splitting into per-source messages lets
 * cache_read grow with the session instead of pinning at the
 * instructions/tools boundary. Each source message is rendered
 * INDEPENDENTLY via `formatSessionHistoryMarkdown` in chunked mode (shared
 * `toolResultIndex` + `consumedToolCallIds` + `watchedRoleState` over the
 * WHOLE delta), so toolCall/toolResult pairings resolve across chunk
 * boundaries and consecutive same-role collapsing is byte-identical to a
 * single-block render. Concatenating the chunk texts reproduces the
 * single-block advisor context exactly.
 *
 * The heading stays on the FIRST chunk; the WIP marker stays on the LAST
 * chunk, so a wip/final flip never changes the stable prefix. See
 * ../../PROVENANCE.md.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { formatSessionHistoryMarkdown } from "./session-history-format.ts";

/** Exact upstream render options for the advisor's context (`ADVISOR_RENDER_OPTIONS`). */
export const ADVISOR_RENDER_OPTIONS = {
  includeToolIntent: true,
  watchedRoles: true,
  expandPrimaryContext: true,
  expandEditDiffs: true,
} as const;

export interface AdvisorDeltaMessage {
  role: "user";
  text: string;
}

export interface RenderAdvisorDeltaOptions {
  wip: boolean;
  includeThinking: boolean;
}

/**
 * Render one batch of primary-transcript delta messages as a sequence of
 * advisor-facing user messages (one per source message that rendered to
 * non-empty text), or `null` if nothing in the batch was renderable.
 */
export function renderAdvisorDeltaMessages(
  delta: AgentMessage[],
  opts: RenderAdvisorDeltaOptions,
): AdvisorDeltaMessage[] | null {
  if (delta.length === 0) return null;

  const resultsByCallId = new Map<string, ToolResultMessage>();
  for (const msg of delta) {
    if (msg.role === "toolResult") resultsByCallId.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
  }
  const consumed = new Set<string>();
  const watchedRoleState = { lastLabel: undefined as string | undefined };

  const renderChunk = (chunk: AgentMessage[]): string =>
    formatSessionHistoryMarkdown(chunk, {
      ...ADVISOR_RENDER_OPTIONS,
      includeThinking: opts.includeThinking,
      toolResultIndex: resultsByCallId,
      consumedToolCallIds: consumed,
      watchedRoleState,
    });

  const heading = "### Session update";
  const chunks: AdvisorDeltaMessage[] = [];
  for (const msg of delta) {
    const text = renderChunk([msg]);
    if (!text.trim()) continue;
    chunks.push({ role: "user", text });
  }
  if (chunks.length === 0) return null;

  chunks[0].text = `${heading}\n\n${chunks[0].text}`;
  if (opts.wip) {
    const last = chunks[chunks.length - 1];
    last.text += `\n\n---\n\n[in progress — more steps follow]`;
  }
  return chunks;
}

/**
 * Concatenate a chunked render back into one string, matching the
 * single-block render byte-for-byte (used where the host needs one string,
 * e.g. a single `session.prompt()` call rather than a multi-message
 * array).
 */
export function joinAdvisorDeltaMessages(chunks: AdvisorDeltaMessage[]): string {
  return chunks.map(c => c.text).join("\n");
}
