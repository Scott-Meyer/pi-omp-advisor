import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advisorSettingsManager } from "./advisor-settings.ts";

test("advisor review sessions keep the person's settings with cache warming off, and never write them", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "advisor-settings-"));
  const cwd = mkdtempSync(join(tmpdir(), "advisor-project-"));
  const settingsPath = join(agentDir, "settings.json");
  const original = JSON.stringify({ defaultProvider: "person-provider", cacheWarming: "idle" });
  writeFileSync(settingsPath, original);

  const settings = advisorSettingsManager(cwd, agentDir) as {
    getGlobalSettings(): Record<string, unknown>;
    setDefaultProvider(provider: string): void;
    flush(): Promise<void>;
  };
  assert.ok(settings, "the host provides the settings APIs");
  assert.equal(settings.getGlobalSettings().defaultProvider, "person-provider");
  assert.equal(settings.getGlobalSettings().cacheWarming, "off");

  settings.setDefaultProvider("changed-by-a-review-session");
  await settings.flush();
  assert.equal(readFileSync(settingsPath, "utf8"), original, "the person's settings file is untouched");
});
