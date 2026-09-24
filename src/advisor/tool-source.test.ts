import assert from "node:assert/strict";
import test from "node:test";
import { toolSourceName } from "./tool-source.ts";

test("tool providers get short names from Pi's registry records", () => {
  assert.equal(toolSourceName({ source: "builtin", path: "<builtin:read>" }), "built-in");
  assert.equal(toolSourceName({ source: "npm:threadroom-pi", origin: "package", path: "/x/index.ts" }), "threadroom-pi");
  assert.equal(toolSourceName({ source: "npm:@scope/tools@1.2.0", origin: "package" }), "@scope/tools");
  assert.equal(toolSourceName({ source: "git:github.com/example/pi-tools@v1", origin: "package" }), "pi-tools");
  assert.equal(toolSourceName({ source: "../../git/pi-parley", origin: "package", path: "/u/git/pi-parley/index.ts" }), "pi-parley");
  assert.equal(toolSourceName({ source: "auto", origin: "top-level", path: "/u/.pi/agent/extensions/hello.ts" }), "hello");
  assert.equal(toolSourceName({ source: "local", origin: "top-level", path: "/u/.pi/agent/extensions/todo/index.ts" }), "todo");
  assert.equal(toolSourceName(undefined), undefined);
});
