import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createPiToolPreview, EXTENSION_PREVIEW_LINES } from "./tool-preview.ts";

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: `${name}-1`, name, arguments: args });
const result = (name: string, text: string): ToolResultMessage =>
  ({ role: "toolResult", toolCallId: `${name}-1`, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1 });
const numbered = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n");

test("tool previews are Pi's own collapsed view: shell tails, no file bodies, capped extension output", async () => {
  initTheme("dark");
  const preview = (await createPiToolPreview(process.cwd()))!;
  assert.ok(preview, "Pi's rendering exports are available");

  const shell = preview(call("bash", { command: "make" }), result("bash", numbered("build line", 40)))!;
  assert.match(shell, /build line 40/, "the end of the output, as Pi shows it");
  assert.doesNotMatch(shell, /build line 1\n/);
  assert.match(shell, /earlier lines not shown/);
  assert.doesNotMatch(shell, /to expand/, "no expand hint the advisor can't use");

  assert.equal(preview(call("read", { path: "src/a.ts" }), result("read", numbered("const secret =", 50))), undefined,
    "Pi shows no file body under a collapsed read");
  assert.equal(preview(call("edit", { path: "a.ts" }), result("edit", "Edited a.ts")), undefined, "edits keep the advisor's own diff");

  const extension = preview(call("ask_user_question", {}), result("ask_user_question", numbered("answer", 30)))!;
  assert.match(extension, /^answer 1\n/);
  assert.match(extension, /more lines not shown/);
  assert.equal(extension.split("\n").length, EXTENSION_PREVIEW_LINES + 1);
});
