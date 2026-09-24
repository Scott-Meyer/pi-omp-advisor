/**
 * Pi's own collapsed preview of a finished tool result: the few lines Pi shows
 * under a tool call before anyone expands it.
 *
 * Tools with a built-in name use Pi's built-in result renderer, which is what
 * Pi itself does for any such tool that doesn't bring its own renderer (for
 * example an extension that reroutes read/bash to a remote host). Other tools
 * get Pi's generic preview, their first text lines, capped at about as much
 * text as a shell preview: their own renderers aren't reachable from another
 * extension, and one long line can otherwise wrap into a page. The cap counts
 * characters, not lines, so a short result with blank lines or one long
 * wrapped line (a question and its answer, say) stays whole.
 *
 * Edits and writes keep the advisor's own bounded diff. Hosts without Pi's
 * rendering exports (OMP) or without an initialized theme (non-interactive
 * modes) get no preview, as before.
 */
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

export type ToolPreview = (call: ToolCall | undefined, result: ToolResultMessage) => string | undefined;

/** Built-ins whose collapsed result Pi renders itself. Edit/write diffs are shown separately. */
const BUILT_INS = { bash: "createBashToolDefinition", powershell: "createPowerShellToolDefinition", read: "createReadToolDefinition", grep: "createGrepToolDefinition", find: "createFindToolDefinition", ls: "createLsToolDefinition" } as const;
const WIDTH = 100;
/** Characters kept from an extension tool's generic preview: about six full-width lines, like a shell preview. */
export const EXTENSION_PREVIEW_CHARACTERS = 600;
const DIFF_TOOLS = new Set(["edit", "write"]);

function capped(text: string, characters: number): string {
  if (text.length <= characters) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 0 && used + line.length + 1 > characters) break;
    kept.push(kept.length === 0 && line.length > characters ? `${line.slice(0, characters)}…` : line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return omitted > 0 ? [...kept, `(${omitted} more lines not shown)`].join("\n") : kept.join("\n");
}

function plain(lines: string[]): string {
  const text = lines.map(line => line.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\s+$/, ""));
  while (text.length && !text[0]) text.shift();
  while (text.length && !text.at(-1)) text.pop();
  const indent = Math.min(...text.filter(Boolean).map(line => line.match(/^ */)![0].length));
  return text.map(line => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n")
    // The advisor can't expand anything.
    .replace(/\(\s*(\d+) (more|earlier) lines?,[^)]*\)/g, "($1 $2 lines not shown)");
}

export async function createPiToolPreview(cwd: string): Promise<ToolPreview | undefined> {
  let pi: Record<string, unknown>, tui: Record<string, unknown>;
  try {
    pi = await import("@earendil-works/pi-coding-agent") as Record<string, unknown>;
    tui = await import("@earendil-works/pi-tui") as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const Component = pi.ToolExecutionComponent as (new (...args: unknown[]) => { markExecutionStarted(): void; setArgsComplete(): void; setExpanded(expanded: boolean): void; updateResult(result: unknown): void; render(width: number): string[] }) | undefined;
  const Text = tui.Text as (new (text: string, x: number, y: number) => unknown) | undefined;
  if (typeof Component !== "function" || typeof Text !== "function") return undefined;
  const definitions = new Map<string, { renderResult?: unknown }>();
  const definition = (name: string) => {
    if (!definitions.has(name)) {
      const factory = pi[BUILT_INS[name as keyof typeof BUILT_INS]];
      definitions.set(name, typeof factory === "function" ? (factory as (cwd: string) => { renderResult?: unknown })(cwd) : {});
    }
    return definitions.get(name)!;
  };
  const ui = { requestRender() {} };
  return (call, result) => {
    if (DIFF_TOOLS.has(result.toolName)) return undefined;
    try {
      const builtIn = result.toolName in BUILT_INS;
      const renderers = {
        renderCall: () => new Text!("", 0, 0),
        ...(builtIn ? { renderResult: definition(result.toolName).renderResult } : {}),
      };
      const component = new Component(result.toolName, result.toolCallId, call?.arguments ?? {}, { showImages: false }, renderers, ui, cwd);
      component.markExecutionStarted();
      component.setArgsComplete();
      // Pi's generic preview stops at its first 10 lines; the character cap below
      // bounds it instead, so a short many-line result isn't cut early.
      if (!builtIn) component.setExpanded(true);
      component.updateResult({ content: result.content, details: result.details, isError: result.isError });
      const text = plain(component.render(WIDTH));
      return (builtIn ? text : capped(text, EXTENSION_PREVIEW_CHARACTERS)) || undefined;
    } catch {
      return undefined;
    }
  };
}
