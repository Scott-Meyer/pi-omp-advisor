/**
 * Pi's own collapsed preview of a finished tool result: the few lines Pi shows
 * under a tool call before anyone expands it.
 *
 * Tools with a built-in name use Pi's built-in result renderer, which is what
 * Pi itself does for any such tool that doesn't bring its own renderer (for
 * example an extension that reroutes read/bash to a remote host). Other tools
 * get Pi's generic preview, their first text lines, capped at the same few
 * lines as a shell preview: their own renderers aren't reachable from another
 * extension, and one long line can otherwise wrap into a page.
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
/** Visible lines kept from an extension tool's generic preview; a shell preview is about this long. */
export const EXTENSION_PREVIEW_LINES = 6;
const DIFF_TOOLS = new Set(["edit", "write"]);

function capped(text: string, lines: number): string {
  const kept = text.split("\n");
  return kept.length <= lines ? text : [...kept.slice(0, lines), `(${kept.length - lines} more lines not shown)`].join("\n");
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
  const Component = pi.ToolExecutionComponent as (new (...args: unknown[]) => { markExecutionStarted(): void; setArgsComplete(): void; updateResult(result: unknown): void; render(width: number): string[] }) | undefined;
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
      component.updateResult({ content: result.content, details: result.details, isError: result.isError });
      const text = plain(component.render(WIDTH));
      return (builtIn ? text : capped(text, EXTENSION_PREVIEW_LINES)) || undefined;
    } catch {
      return undefined;
    }
  };
}
