import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { advisorCustomMessageType, advisorSessionToolOptions, disableNestedHostAdvisor, findAdvisorModel, isOmpExtensionApi, isOmpHost, isOmpUserResumeMessage, ompAgentEndWasAborted, piHostModelRuntime } from "./host-compat.ts";

const model = { provider: "fixture", id: "reviewer" } as Model<Api>;

test("host model lookup accepts OMP and Pi registry contracts", () => {
  assert.equal(findAdvisorModel({ find: (provider, id) => provider === "fixture" && id === "reviewer" ? model : undefined }, "fixture", "reviewer"), model);
  assert.equal(findAdvisorModel({ getModel: (provider, id) => provider === "fixture" && id === "reviewer" ? model : undefined }, "fixture", "reviewer"), model);
  assert.equal(findAdvisorModel({}, "fixture", "missing"), undefined);
});

test("the initialization API distinguishes OMP before session_start", () => {
  const omp = { runtime: {}, pi: {} };
  const pi = { registerCommand() {}, events: {} };
  assert.equal(isOmpExtensionApi(omp), true);
  assert.equal(isOmpExtensionApi(pi), false);
  assert.equal(advisorCustomMessageType(omp), "pi-omp-advisor", "OMP avoids its native advisor renderer collision");
  assert.equal(advisorCustomMessageType(pi), "advisor", "Pi retains its established transcript type");
});

test("OMP child sessions are restricted without passing string names as tool objects", () => {
  const modelRegistry = { find: () => model };
  const ctx = { models: {}, modelRegistry } as unknown as ExtensionContext;
  assert.equal(isOmpHost(ctx), true);
  const options = advisorSessionToolOptions(ctx, ["read", "advise"]);
  assert.deepEqual(options.toolNames, ["read", "advise"]);
  assert.equal(options.tools, undefined);
  assert.equal(options.restrictToolNames, true);
  assert.equal(options.allowRestrictedCustomTools, true);
  assert.equal(options.disableExtensionDiscovery, true);
  assert.equal(options.enableMCP, false);
  assert.equal(options.enableLsp, false);
  assert.deepEqual(options.skills, []);
  assert.equal(options.modelRegistry, modelRegistry);
});

test("OMP resume detection includes skills but excludes steering and agent messages", () => {
  assert.equal(isOmpUserResumeMessage({ role: "user", attribution: "user" }), true);
  assert.equal(isOmpUserResumeMessage({ role: "custom", attribution: "user" }), true);
  assert.equal(isOmpUserResumeMessage({ role: "custom", attribution: "agent" }), false);
  assert.equal(isOmpUserResumeMessage({ role: "user", attribution: "user", steering: true }), false);
});

test("OMP abort detection uses the latest run, not an aborted historical turn", () => {
  assert.equal(ompAgentEndWasAborted([
    { role: "assistant", stopReason: "stop" },
    { role: "assistant", stopReason: "aborted" },
  ]), true);
  assert.equal(ompAgentEndWasAborted([
    { role: "assistant", stopReason: "aborted" },
    { role: "user" },
    { role: "assistant", stopReason: "stop" },
  ]), false);
});

test("OMP's native advisor is disabled only inside the extension-owned child", () => {
  const ctx = { models: {} } as unknown as ExtensionContext;
  const calls: boolean[] = [];
  disableNestedHostAdvisor(ctx, { setAdvisorEnabled: (enabled: boolean) => { calls.push(enabled); } });
  assert.deepEqual(calls, [false]);

  disableNestedHostAdvisor({} as ExtensionContext, { setAdvisorEnabled: (enabled: boolean) => { calls.push(enabled); } });
  assert.deepEqual(calls, [false], "Pi sessions keep their existing behavior");

  let disposed = 0;
  assert.throws(
    () => disableNestedHostAdvisor(ctx, { dispose: () => { disposed++; } }),
    /session-local advisor controls/,
  );
  assert.equal(disposed, 1, "an incompatible OMP child cannot leak after creation");
  assert.throws(
    () => disableNestedHostAdvisor(ctx, {
      setAdvisorEnabled: () => { throw new Error("disable failed"); },
      dispose: () => { disposed++; },
    }),
    /disable failed/,
  );
  assert.equal(disposed, 2, "a child whose native advisor could not be disabled is disposed");
});

test("Pi child sessions keep the Pi tools allowlist contract", () => {
  const ctx = {} as ExtensionContext;
  assert.equal(isOmpHost(ctx), false);
  assert.deepEqual(advisorSessionToolOptions(ctx, ["read", "advise"]), { tools: ["read", "advise"] });
});

test("Pi advisors reuse the live host runtime that owns session-only auth and providers", () => {
  const runtime = { streamSimple() {} };
  const pi = { modelRegistry: { runtime } } as unknown as ExtensionContext;
  assert.equal(piHostModelRuntime(pi), runtime);

  const missingCapability = { modelRegistry: { runtime: {} } } as unknown as ExtensionContext;
  assert.equal(piHostModelRuntime(missingCapability), undefined);
  assert.equal(piHostModelRuntime({ models: {}, modelRegistry: { runtime } } as unknown as ExtensionContext), undefined);
});
