/**
 * An optional, advisor-written note about the bigger picture: what the person
 * is trying to accomplish, as the advisor understands it. The advisor's model
 * context is bounded and expires wholesale; this note is what it hands its
 * future self across that gap. It is shown again only when a context window
 * starts without earlier history, and it is always framed as the advisor's own
 * earlier interpretation — never as something the person said.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const NOTEBOOK_TOOL_NAME = "notebook";
/** Deliberately small: a sense of purpose, not a transcript or a rulebook. */
export const NOTEBOOK_MAX_CHARS = 1_200;

export interface NotebookEntry {
  text: string;
  updatedAt: number;
}

export interface NotebookAccess {
  read(): NotebookEntry | undefined;
  write(entry: NotebookEntry): void;
}

export function makeNotebookTool(access: NotebookAccess): ReturnType<typeof defineTool> {
  return defineTool({
    name: NOTEBOOK_TOOL_NAME,
    label: "Notebook",
    description: "Replace your short note to your future self about what the person is trying to accomplish. You'll see it again when your context starts fresh. An empty text clears it.",
    parameters: Type.Object({
      text: Type.String({ maxLength: NOTEBOOK_MAX_CHARS, description: `The whole note (up to ${NOTEBOOK_MAX_CHARS} characters). Replaces the previous one.` }),
    }),
    async execute(_toolCallId, params) {
      const text = params.text.trim().slice(0, NOTEBOOK_MAX_CHARS);
      const previous = access.read()?.text.trim() || undefined;
      access.write({ text, updatedAt: Date.now() });
      // Show what was replaced, so dropping or reshaping something is visible.
      const reply = [
        text ? "Saved. You'll see this again when your context starts fresh." : "Cleared.",
        ...(previous && previous !== text ? [`It replaced:\n\n${quote(previous)}`] : []),
      ].join("\n\n");
      return { content: [{ type: "text", text: reply }], details: { text, previous } };
    },
  });
}

function quote(text: string): string {
  return text.split("\n").map(line => line ? `> ${line}` : ">").join("\n");
}

/** How a previous note reads at the start of a fresh context window. */
export function formatNotebookHandover(entry: NotebookEntry | undefined): string | undefined {
  if (!entry?.text.trim()) return undefined;
  const quoted = quote(entry.text.trim());
  return [
    `Your notebook, written by you before this context began (last updated ${new Date(entry.updatedAt).toISOString()}). ` +
      "It is your own earlier reading of what the person is after, not something they said, and it may be stale or wrong. " +
      "What the person actually says takes precedence.",
    quoted,
  ].join("\n\n");
}
