import assert from "node:assert/strict";
import test from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { getAdvisorArgumentCompletions } from "./index.ts";

test("offers documented advisor subcommands with descriptions", () => {
  const completions = getAdvisorArgumentCompletions("");

  assert.ok(completions);
  assert.deepEqual(
    completions.map(item => item.value),
    [
      "menu",
      "status",
      "inbox",
      "stream",
      "queue",
      "pause",
      "resume",
      "clear",
      "on",
      "off",
      "config",
      "main on",
      "main off",
      "subagents on",
      "subagents off",
      "help",
    ],
  );
  assert.ok(completions.every(item => item.description));
});

test("filters advisor completions without producing malformed tab replacements", () => {
  assert.deepEqual(getAdvisorArgumentCompletions("pau")?.map(item => item.value), ["pause"]);
  assert.deepEqual(getAdvisorArgumentCompletions("main ")?.map(item => item.value), ["main on", "main off"]);
  assert.deepEqual(getAdvisorArgumentCompletions("  subagents o")?.map(item => item.value), ["subagents on", "subagents off"]);
  assert.equal(getAdvisorArgumentCompletions("not-a-command"), null);
});

test("integrates with Pi's argument provider and replaces only the subcommand prefix", async () => {
  const provider = new CombinedAutocompleteProvider(
    [
      {
        name: "advisor",
        getArgumentCompletions: getAdvisorArgumentCompletions,
      },
    ],
    process.cwd(),
  );
  const input = "/advisor pau";
  const suggestions = await provider.getSuggestions([input], 0, input.length, {
    signal: new AbortController().signal,
    force: false,
  });

  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "pau");
  assert.deepEqual(suggestions.items.map(item => item.value), ["pause"]);
  assert.deepEqual(provider.applyCompletion([input], 0, input.length, suggestions.items[0]!, suggestions.prefix), {
    lines: ["/advisor pause"],
    cursorLine: 0,
    cursorCol: "/advisor pause".length,
  });
});
