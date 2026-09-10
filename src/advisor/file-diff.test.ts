import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  FileMutationTracker,
  generateUnifiedDiff,
  truncateDiffLines,
  DEFAULT_DIFF_CONTEXT_LINES,
} from "./file-diff.ts";

test("generateUnifiedDiff generates an 8-context-line diff for modified files", () => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const newLines = Array.from({ length: 20 }, (_, i) => (i === 10 ? "line 11 (changed)" : `line ${i + 1}`)).join("\n") + "\n";

  const diff = generateUnifiedDiff("src/example.ts", oldLines, newLines);
  assert.ok(diff !== undefined);
  assert.match(diff, /^--- a\/src\/example\.ts/m);
  assert.match(diff, /^\+\+\+ b\/src\/example\.ts/m);
  assert.match(diff, /^-line 11$/m);
  assert.match(diff, /^\+line 11 \(changed\)$/m);
  // Default context is 8 lines: lines 3 through 19 should be in the hunk
  assert.match(diff, / line 3/);
  assert.match(diff, / line 19/);
});

test("generateUnifiedDiff creates a new-file diff from /dev/null when oldContent is null", () => {
  const content = "export const answer = 42;\n";
  const diff = generateUnifiedDiff("src/new-file.ts", null, content);
  assert.ok(diff !== undefined);
  assert.match(diff, /^--- \/dev\/null/m);
  assert.match(diff, /^\+\+\+ b\/src\/new-file\.ts/m);
  assert.match(diff, /^\+export const answer = 42;$/m);
});

test("generateUnifiedDiff returns undefined for identical contents", () => {
  const content = "same old text\n";
  const diff = generateUnifiedDiff("src/same.ts", content, content);
  assert.equal(diff, undefined);
});

test("truncateDiffLines limits output to maxLines and appends omission notice", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `+added line ${i}`).join("\n");
  const truncated = truncateDiffLines(lines, 10);
  const resultLines = truncated.split("\n");
  assert.equal(resultLines.length, 11);
  assert.match(resultLines[10]!, /\.\.\. \[40 lines of diff omitted\]/);
});

test("FileMutationTracker captures write on existing file and returns diff on result", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-diff-test-"));
  try {
    const filePath = path.join(dir, "test.txt");
    await fs.writeFile(filePath, "initial line 1\ninitial line 2\n", "utf8");

    const tracker = new FileMutationTracker();
    await tracker.onToolStart("call-1", "write", { path: "test.txt", content: "initial line 1\nupdated line 2\n" }, dir);

    // Simulate write modifying disk
    await fs.writeFile(filePath, "initial line 1\nupdated line 2\n", "utf8");

    const diff = await tracker.onToolResult("call-1", "write", false);
    assert.ok(diff !== undefined);
    assert.match(diff, /--- a\/test\.txt/);
    assert.match(diff, /-initial line 2/);
    assert.match(diff, /\+updated line 2/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("FileMutationTracker captures write for newly created file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-diff-test-"));
  try {
    const filePath = path.join(dir, "brand-new.txt");
    const tracker = new FileMutationTracker();
    await tracker.onToolStart("call-new", "write", { path: "brand-new.txt", content: "brand new content\n" }, dir);

    // Simulate write creating the file
    await fs.writeFile(filePath, "brand new content\n", "utf8");

    const diff = await tracker.onToolResult("call-new", "write", false);
    assert.ok(diff !== undefined);
    assert.match(diff, /--- \/dev\/null/);
    assert.match(diff, /\+brand new content/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("FileMutationTracker captures edit on existing file and generates 8-context-line diff", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-diff-test-"));
  try {
    const filePath = path.join(dir, "edit-target.txt");
    const oldLines = Array.from({ length: 25 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await fs.writeFile(filePath, oldLines, "utf8");

    const tracker = new FileMutationTracker();
    await tracker.onToolStart("call-edit", "edit", { path: "edit-target.txt", edits: [{ oldText: "row 12", newText: "row 12 (edited)" }] }, dir);

    // Simulate edit writing to disk
    const newLines = Array.from({ length: 25 }, (_, i) => (i === 11 ? "row 12 (edited)" : `row ${i + 1}`)).join("\n") + "\n";
    await fs.writeFile(filePath, newLines, "utf8");

    const diff = await tracker.onToolResult("call-edit", "edit", false);
    assert.ok(diff !== undefined);
    assert.match(diff, /-row 12$/m);
    assert.match(diff, /\+row 12 \(edited\)$/m);
    // Context of 8 lines around row 12 includes row 4 and row 20
    assert.match(diff, / row 4/);
    assert.match(diff, / row 20/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("FileMutationTracker discards snapshot on tool error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-diff-test-"));
  try {
    const filePath = path.join(dir, "error-target.txt");
    await fs.writeFile(filePath, "original\n", "utf8");

    const tracker = new FileMutationTracker();
    await tracker.onToolStart("call-err", "edit", { path: "error-target.txt" }, dir);
    tracker.onToolEnd("call-err", true);

    const diff = await tracker.onToolResult("call-err", "edit", true);
    assert.equal(diff, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
