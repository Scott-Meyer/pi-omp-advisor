import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Diff from "diff";

export const DEFAULT_DIFF_CONTEXT_LINES = 8;
export const MAX_DIFF_LINES = 200;

export interface UnifiedDiffOptions {
  contextLines?: number;
  maxLines?: number;
}

/**
 * Truncate a multi-line diff to a safe line ceiling to protect model context.
 */
export function truncateDiffLines(diff: string, maxLines = MAX_DIFF_LINES): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  const kept = lines.slice(0, maxLines);
  const omitted = lines.length - maxLines;
  kept.push(`... [${omitted} lines of diff omitted]`);
  return kept.join("\n");
}

/**
 * Generate a standard unified diff between oldContent and newContent.
 * If oldContent is null, diffs from /dev/null to represent a newly created file.
 * Returns undefined if contents are identical or cannot be diffed.
 */
export function generateUnifiedDiff(
  filePath: string,
  oldContent: string | null,
  newContent: string,
  opts?: UnifiedDiffOptions,
): string | undefined {
  if (oldContent !== null && oldContent === newContent) {
    return undefined;
  }
  // Sanity check: avoid diffing massive text or binary blobs
  if (newContent.length > 1_000_000 || newContent.includes("\0")) {
    return undefined;
  }
  if (oldContent !== null && (oldContent.length > 1_000_000 || oldContent.includes("\0"))) {
    return undefined;
  }

  const context = opts?.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES;
  const oldPath = oldContent === null ? "/dev/null" : `a/${filePath}`;
  const newPath = `b/${filePath}`;
  const rawPatch = Diff.createTwoFilesPatch(
    oldPath,
    newPath,
    oldContent ?? "",
    newContent,
    "",
    "",
    { context },
  );

  // Strip createTwoFilesPatch decoration banner if present
  let cleanPatch = rawPatch.replace(/^={10,}\r?\n/, "");
  cleanPatch = cleanPatch.trim();
  if (!cleanPatch) return undefined;

  const maxLines = opts?.maxLines ?? MAX_DIFF_LINES;
  return truncateDiffLines(cleanPatch, maxLines);
}

interface PendingMutationSnapshot {
  path: string;
  fullPath: string;
  oldContent: string | null;
  toolName: string;
}

/**
 * Tracks in-flight file mutation tool calls (`write` and `edit`) by capturing
 * pre-mutation file state at tool execution start, then computing an 8-line
 * context unified diff on successful completion.
 */
export class FileMutationTracker {
  readonly #snapshots = new Map<string, PendingMutationSnapshot>();

  /**
   * Called on `tool_execution_start`. Reads existing file content before
   * the tool mutates disk.
   */
  async onToolStart(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    cwd: string,
  ): Promise<void> {
    if (toolName !== "write" && toolName !== "edit") return;
    const rawPath = String(args?.path ?? args?.file_path ?? args?.filePath ?? "").trim();
    if (!rawPath) return;

    const fullPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
    let oldContent: string | null = null;
    try {
      oldContent = fsSync.readFileSync(fullPath, "utf8");
    } catch {
      oldContent = null;
    }

    this.#snapshots.set(toolCallId, {
      path: rawPath,
      fullPath,
      oldContent,
      toolName,
    });
  }

  /**
   * Called on `tool_execution_end` when a tool fails or aborts.
   */
  onToolEnd(toolCallId: string, isError: boolean): void {
    if (isError) {
      this.#snapshots.delete(toolCallId);
    }
  }

  /**
   * Called on `message_end` for a `toolResult`. If the mutation succeeded,
   * reads post-mutation content from disk and returns the unified diff.
   */
  async onToolResult(
    toolCallId: string,
    toolName: string,
    isError: boolean,
  ): Promise<string | undefined> {
    const snap = this.#snapshots.get(toolCallId);
    if (!snap) return undefined;
    this.#snapshots.delete(toolCallId);
    if (isError) return undefined;

    try {
      const newContent = await fs.readFile(snap.fullPath, "utf8");
      return generateUnifiedDiff(snap.path, snap.oldContent, newContent);
    } catch {
      return undefined;
    }
  }

  clear(): void {
    this.#snapshots.clear();
  }
}
