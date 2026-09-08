#!/usr/bin/env node
import { readFileSync } from "node:fs";

// Run from the repository root. With no tag, validate/pack only (manual CI).
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const tag = process.argv[2] ?? `v${pkg.version}`;

if (typeof pkg.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error("Use a release version such as 1.2.3 or 1.2.3-rc.1 (without build metadata).");
}
if (tag !== `v${pkg.version}`) {
  throw new Error(`Tag ${tag} does not match package.json version v${pkg.version}.`);
}
if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
  throw new Error("package-lock.json versions do not match package.json; update them together.");
}

console.log(`version=${pkg.version}`);
console.log(`dist-tag=${pkg.version.includes("-") ? "next" : "latest"}`);
