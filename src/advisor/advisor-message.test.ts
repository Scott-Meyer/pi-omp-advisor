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
        { advisor: "security", severity: "blocker", note: "First note" },
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
  const lines = component.render(48);
  const text = stripVTControlCharacters(lines.join("\n"));

  assert.match(lines[0]!, /^╭/u);
  assert.match(lines.at(-1)!, /^╰/u);
  assert.match(text, /First note/u);
  assert.match(text, /Second note/u);
  assert.match(text, /Third note/u);
  assert.match(text, /Fourth note/u);
  assert.doesNotMatch(text, /more notes/u);
  assert.ok(lines.every(line => visibleWidth(line) <= 48));
});

test("renders restored messages without structured note details", () => {
  const component = renderAdvisorMessage(undefined, "legacy advisor message", { expanded: false }, plainTheme);
  assert.ok(component);
  const text = component.render(40).join("\n");
  assert.match(text, /Advisor/u);
  assert.match(text, /legacy advisor message/u);
});
