import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAdvisorMessage } from "./advisor-message.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("renders every advisor note in a bordered card without collapsing", () => {
  const component = renderAdvisorMessage(
    {
      notes: [
        { advisor: "security", model: "anthropic/claude-sonnet", severity: "blocker", note: "First note", shortTitle: "Auth bypass in flush logic" },
        { advisor: "tests", model: "openai/gpt-5", severity: "concern", note: "Second note" },
        { advisor: "types", severity: "nit", note: "Third note" },
        { advisor: "docs", note: "Fourth note that is intentionally long enough to wrap onto another line" },
      ],
    },
    "unused structured content",
    { expanded: false },
    plainTheme,
  );

  assert.ok(component);
  const lines = component.render(72);
  const text = stripVTControlCharacters(lines.join("\n"));

  assert.match(lines[0]!, /^╭/u);
  assert.match(lines.at(-1)!, /^╰/u);
  assert.match(text, /MODEL\s+security · anthropic\/claude-sonnet/u, "each route remains visible on a wrapped model line");
  assert.match(text, /BLOCKER\s+security\s+Auth bypass in flush logic/u, "a titled note keeps its source and title");
  assert.match(text, /MODEL\s+tests · openai\/gpt-5/u);
  assert.match(text, /CONCERN\s+tests/u, "an untitled note still keeps its source");
  assert.match(text, /First note/u);
  assert.match(text, /Second note/u);
  assert.match(text, /Third note/u);
  assert.match(text, /Fourth note/u);
  assert.doesNotMatch(text, /more notes/u);
  assert.ok(lines.every(line => visibleWidth(line) <= 72));
});

test("a lone titled note keeps its full model and title visible at ordinary and narrow widths", () => {
  const component = renderAdvisorMessage(
    {
      notes: [
        { advisor: "advisor", model: "openai-codex/gpt-5.6-sol", severity: "blocker", note: "The early flush path never clears the timer, so a later batch double-delivers", shortTitle: "Timer leak on early flush" },
      ],
    },
    "unused structured content",
    { expanded: false },
    plainTheme,
  );

  assert.ok(component);
  const lines = component.render(80);
  const text = stripVTControlCharacters(lines.join("\n"));

  assert.match(lines[0]!, /Advisor · advisor · openai-codex\/gpt-5\.6-sol · 1 note · 1 blocker/u, "the header identifies the advisor model and summarizes the note");
  assert.match(lines[0]!, /^╭.*╮$/u);
  assert.match(text, /MODEL\s+advisor · openai-codex\/gpt-5\.6-sol/u, "the full model route is visible in the card body");
  assert.match(text, /Timer leak on early flush/u, "the full title remains visible in either the headline or wrapped body");
  assert.match(text, /double-delivers/u);
  assert.ok(lines.every(line => visibleWidth(line) <= 80));

  // The same card at a width that truncates the headline: the top rule must
  // stay exactly the frame width, not one column wider.
  const narrow = component.render(40);
  assert.match(narrow[0]!, /^╭[\u2500\u256d]?.*\u256e$/u);
  assert.ok(narrow.every(line => visibleWidth(line) <= 40), "a truncated headline must not widen the top border");
  assert.match(stripVTControlCharacters(narrow.join("\n")).replace(/\s+/g, " "), /openai-codex\/gpt-5\.6-sol/u, "the model wraps rather than disappearing at narrow widths");
  assert.match(stripVTControlCharacters(narrow.join("\n")).replace(/\s+/g, " "), /Timer leak on early flush/u, "the title wraps rather than disappearing at narrow widths");
});

test("mixed current and restored notes retain every advisor attribution", () => {
  const component = renderAdvisorMessage(
    {
      notes: [
        { advisor: "security", model: "openai/gpt-5", severity: "concern", note: "Current note" },
        { advisor: "docs", severity: "nit", note: "Restored legacy note" },
      ],
    },
    "unused structured content",
    { expanded: false },
    plainTheme,
  );
  const text = stripVTControlCharacters(component!.render(72).join("\n"));
  assert.match(text, /MODEL\s+security · openai\/gpt-5/u);
  assert.match(text, /CONCERN\s+security/u);
  assert.match(text, /NIT\s+docs/u, "a restored model-less note is not mislabeled as the other advisor");
});

test("renders restored messages without structured note details", () => {
  const component = renderAdvisorMessage(undefined, "legacy advisor message", { expanded: false }, plainTheme);
  assert.ok(component);
  const text = component.render(40).join("\n");
  assert.match(text, /Advisor/u);
  assert.match(text, /legacy advisor message/u);
});
