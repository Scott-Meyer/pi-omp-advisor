/**
 * Regression tests for the config edit round-trip.
 *
 * Both bugs covered here were shipped once and were silently destructive: the
 * editable document returned by `loadWatchdogConfigFile` is exactly what
 * `saveWatchdogConfigFile` writes back, so (a) any field the loader forgets to
 * read is a field an edit erases, and (b) any unreadable file the loader reports
 * as "empty" gets overwritten with a blank config by the first save.
 *
 * Run: npm test    (node --test --experimental-strip-types)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  WatchdogConfigUnreadableError,
  discoverAdvisorConfigs,
  loadWatchdogConfigFile,
  serializeWatchdogConfig,
  type WatchdogConfigDoc,
} from "./watchdog-config.ts";

let dir: string;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-omp-advisor-test-"));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, body, "utf8");
  return file;
}

describe("loadWatchdogConfigFile", () => {
  it("round-trips every field the serializer writes", async () => {
    const file = await writeConfig(
      "full.yml",
      [
        "main: true",
        "subagents: true",
        "syncBacklog: 3",
        "immuneTurns: 5",
        "instructions: shared baseline",
        "advisors:",
        "  - name: reviewer",
        "    model: openai/gpt-5.1-codex-mini",
        "    tools: [read, grep]",
        "    enabled: false",
        "    contextTokens: 16000",
        "    includePrimaryThinking: false",
        "",
      ].join("\n"),
    );

    const loaded = await loadWatchdogConfigFile(file);
    // The specific regression: syncBacklog/immuneTurns were serialized but never
    // parsed back, so a save dropped them.
    assert.equal(loaded.syncBacklog, 3);
    assert.equal(loaded.immuneTurns, 5);
    assert.equal(loaded.main, true);
    assert.equal(loaded.subagents, true);
    assert.equal(loaded.instructions, "shared baseline");
    assert.equal(loaded.advisors.length, 1);

    // Simulate `/advisor main off`: toggle one field, save, reload.
    loaded.main = false;
    await fs.writeFile(file, await serializeWatchdogConfig(loaded), "utf8");
    const reloaded = await loadWatchdogConfigFile(file);

    assert.equal(reloaded.main, false, "toggled field should persist");
    assert.equal(reloaded.syncBacklog, 3, "syncBacklog must survive an unrelated edit");
    assert.equal(reloaded.immuneTurns, 5, "immuneTurns must survive an unrelated edit");
    assert.equal(reloaded.instructions, "shared baseline");
    assert.equal(reloaded.advisors[0]?.name, "reviewer");
    assert.equal(reloaded.advisors[0]?.enabled, false);
    assert.equal(reloaded.advisors[0]?.contextTokens, 16000);
    assert.equal(reloaded.advisors[0]?.includePrimaryThinking, false);
  });

  it("discovers explicit memory settings and refuses unsafe fallback from invalid settings", async () => {
    const cwd = await fs.mkdtemp(path.join(dir, "memory-"));
    const agentDir = path.join(cwd, "agent");
    await fs.mkdir(agentDir);
    const file = path.join(cwd, "WATCHDOG.yml");
    await fs.writeFile(file, "advisors:\n  - name: reviewer\n    contextTokens: 150000\n    includePrimaryThinking: true\n");
    const valid = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(valid.advisors[0]?.contextTokens, 150000);
    assert.equal(valid.advisors[0]?.includePrimaryThinking, true);
    for (const field of ["contextTokens: 0", "contextTokens: 2048.5", "contextTokens: nope", "includePrimaryThinking: yes"]) {
      const original = `advisors:\n  - name: reviewer\n    ${field}\n`;
      await fs.writeFile(file, original);
      await assert.rejects(() => loadWatchdogConfigFile(file), WatchdogConfigUnreadableError);
      const invalid = await discoverAdvisorConfigs(cwd, agentDir);
      assert.equal(invalid.advisors.length, 1, "invalid explicit advisor cannot become an implicit default");
      assert.equal(invalid.advisors[0]?.enabled, false);
      assert.equal(await fs.readFile(file, "utf8"), original);
    }
  });

  it("accepts syncBacklog: off", async () => {
    const file = await writeConfig("off.yml", "syncBacklog: off\n");
    assert.equal((await loadWatchdogConfigFile(file)).syncBacklog, "off");
  });

  it("returns an empty document for a missing file", async () => {
    const loaded = await loadWatchdogConfigFile(path.join(dir, "does-not-exist.yml"));
    assert.deepEqual(loaded, { advisors: [] });
  });

  it("returns an empty document for a blank or comment-only file", async () => {
    const blank = await writeConfig("blank.yml", "");
    assert.deepEqual(await loadWatchdogConfigFile(blank), { advisors: [] });
    const comments = await writeConfig("comments.yml", "# just a comment\n");
    assert.deepEqual(await loadWatchdogConfigFile(comments), { advisors: [] });
  });

  it("refuses malformed YAML instead of reporting it as empty", async () => {
    const file = await writeConfig("broken.yml", "advisors:\n  - name: [unclosed\n");
    await assert.rejects(() => loadWatchdogConfigFile(file), WatchdogConfigUnreadableError);
  });

  it("refuses a non-mapping document root", async () => {
    const seq = await writeConfig("sequence.yml", "- one\n- two\n");
    await assert.rejects(() => loadWatchdogConfigFile(seq), WatchdogConfigUnreadableError);
    const scalar = await writeConfig("scalar.yml", "just a string\n");
    await assert.rejects(() => loadWatchdogConfigFile(scalar), WatchdogConfigUnreadableError);
  });

  it("never silently truncates a config it cannot understand", async () => {
    // End-to-end shape of the shipped bug: toggle a flag against a malformed
    // file. The command must abort, leaving the file byte-for-byte intact.
    const original = "advisors:\n  - name: [unclosed\n";
    const file = await writeConfig("preserve.yml", original);
    let doc: WatchdogConfigDoc | undefined;
    try {
      doc = await loadWatchdogConfigFile(file);
      doc.main = true;
      await fs.writeFile(file, await serializeWatchdogConfig(doc), "utf8");
    } catch {
      /* expected */
    }
    assert.equal(doc, undefined, "must not produce a document to save");
    assert.equal(await fs.readFile(file, "utf8"), original, "file must be untouched");
  });
});
