import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createPiToolPreview, EXTENSION_PREVIEW_CHARACTERS } from "./tool-preview.ts";

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

  const long = preview(call("mcp", {}), result("mcp", numbered("row " + "x".repeat(90), 30)))!;
  assert.match(long, /^row x+ 1\n/);
  assert.match(long, /more lines not shown/);
  assert.ok(long.length < EXTENSION_PREVIEW_CHARACTERS + 100, "bounded like a shell preview");

  // A real question result from this session: short, but blank lines and one line that wraps.
  const answered = 'The person answered:\n\n"Pick a color for this test (any is fine)."\nChose: "Teal" (option 1)\n\n' +
    '"Type a short sentence in your own words (anything), so we can check whether the advisor sees what you wrote."\nChose: "Looks good so far" (option 2)';
  const question = preview(call("ask_user_question", {}), result("ask_user_question", answered))!;
  assert.match(question, /Chose: "Teal"/);
  assert.match(question, /Chose: "Looks good so far"/, "a short result is shown whole");
  assert.doesNotMatch(question, /not shown/);

  // Four short answers put the last one past Pi's 10-line generic preview while staying well under the cap.
  const four = "The person answered:\n\n" + [1, 2, 3, 4].map(n => `"Question ${n}?"\nChose: "Option ${n}"`).join("\n\n");
  assert.ok(four.split("\n").length > 10 && four.length < EXTENSION_PREVIEW_CHARACTERS);
  const fourPreview = preview(call("ask_user_question", {}), result("ask_user_question", four))!;
  assert.match(fourPreview, /Chose: "Option 4"/);
  assert.doesNotMatch(fourPreview, /not shown/);
});
