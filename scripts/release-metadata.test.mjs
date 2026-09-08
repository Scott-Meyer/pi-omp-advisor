import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./release-metadata.mjs", import.meta.url));

function check(t, version, tag, lockVersion = version, rootVersion = version) {
  const cwd = mkdtempSync(join(tmpdir(), "advisor-release-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({
    version: lockVersion, packages: { "": { version: rootVersion } },
  }));
  return spawnSync(process.execPath, [script, ...(tag === undefined ? [] : [tag])], {
    cwd, encoding: "utf8",
  });
}

test("stable tags publish to latest and prereleases to next", t => {
  const stable = check(t, "1.2.3", "v1.2.3");
  assert.equal(stable.status, 0, stable.stderr);
  assert.equal(stable.stdout, "version=1.2.3\ndist-tag=latest\n");
  const prerelease = check(t, "1.3.0-rc.1", "v1.3.0-rc.1");
  assert.equal(prerelease.status, 0, prerelease.stderr);
  assert.equal(prerelease.stdout, "version=1.3.0-rc.1\ndist-tag=next\n");
});

test("mismatched tags and either stale lockfile version block publication", t => {
  for (const args of [
    ["1.2.3", "v1.2.4"],
    ["1.2.3", "main"],
    ["1.2.3", "v1.2.3", "1.2.2"],
    ["1.2.3", "v1.2.3", "1.2.3", "1.2.2"],
  ]) {
    const result = check(t, ...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(result.stdout, "");
  }
});

test("manual validation derives the version without a release tag", t => {
  const result = check(t, "1.2.3");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "version=1.2.3\ndist-tag=latest\n");
});
