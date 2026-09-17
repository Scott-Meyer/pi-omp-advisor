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
        { advisor: "security", severity: "blocker", note: "First note", shortTitle: "Auth bypass in flush logic" },
        { advisor: "tests", severity: "concern", note: "Second note" },
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
  assert.match(text, /BLOCKER\s+security\s+Auth bypass in flush logic/u, "a titled note carries its shortTitle on the label line");
  assert.match(text, /CONCERN\s+tests/u, "an untitled note renders no title separator");
  assert.match(text, /First note/u);
  assert.match(text, /Second note/u);
  assert.match(text, /Third note/u);
  assert.match(text, /Fourth note/u);
  assert.doesNotMatch(text, /more notes/u);
  assert.ok(lines.every(line => visibleWidth(line) <= 72));
});

test("a lone titled note carries its title as the card's headline in the top rule", () => {
  const component = renderAdvisorMessage(
    {
      notes: [
        { advisor: "advisor", severity: "blocker", note: "The early flush path never clears the timer, so a later batch double-delivers", shortTitle: "Timer leak on early flush" },
      ],
    },
    "unused structured content",
    { expanded: false },
    plainTheme,
  );

  assert.ok(component);
  const lines = component.render(80);
  const text = stripVTControlCharacters(lines.join("\n"));

  assert.match(lines[0]!, /Advisor · 1 note · 1 blocker ─ Timer leak on early flush/u, "the title sits in the header rule");
  assert.match(lines[0]!, /^╭.*╮$/u);
  assert.doesNotMatch(text, /BLOCKER\s+advisor\s+Timer/u, "the title is not repeated on the label line for a lone note");
  assert.match(text, /BLOCKER\s+advisor/u);
  assert.match(text, /double-delivers/u);
  assert.ok(lines.every(line => visibleWidth(line) <= 80));

  // The same card at a width that truncates the headline: the top rule must
  // stay exactly the frame width, not one column wider.
  const narrow = component.render(40);
  assert.match(narrow[0]!, /^╭[\u2500\u256d]?.*\u256e$/u);
  assert.ok(narrow.every(line => visibleWidth(line) <= 40), "a truncated headline must not widen the top border");
});

test("renders restored messages without structured note details", () => {
  const component = renderAdvisorMessage(undefined, "legacy advisor message", { expanded: false }, plainTheme);
  assert.ok(component);
  const text = component.render(40).join("\n");
  assert.match(text, /Advisor/u);
  assert.match(text, /legacy advisor message/u);
});
