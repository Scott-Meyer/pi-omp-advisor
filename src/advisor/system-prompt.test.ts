import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAdvisorSystemPrompt } from "./system-prompt.ts";

test("project paths and instructions preserve literal replacement characters", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "advisor-prompt-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = "docs/$&-$$-$`-$'.md";
  const content = "Shell and regex examples: $& $$ $` $'\nKeep these exact bytes when reviewing the implementation.";
  const prompt = await buildAdvisorSystemPrompt({
    cwd, watchdogBlocks: [], sharedInstructions: undefined, advisorInstructions: undefined,
    contextFiles: [{ path, content }],
  });
  assert.ok(prompt.includes(`<file path="${path}">\n${content}\n</file>`));
  assert.ok(!prompt.includes("{{content}}"));
});

test("a direct-child repository hint preserves literal path characters without asserting cwd is outside git", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "advisor-repo-hint-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = "repo-$&-$$";
  await mkdir(join(cwd, child, ".git"), { recursive: true });
  const prompt = await buildAdvisorSystemPrompt({
    cwd, watchdogBlocks: [], sharedInstructions: undefined, advisorInstructions: undefined,
  });
  assert.ok(prompt.includes(`\`${child}\``));
  assert.ok(!prompt.includes("Session cwd: outside git"));
});
