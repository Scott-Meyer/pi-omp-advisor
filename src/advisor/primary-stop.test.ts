import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { PrimaryStopController, formatStopReceipt, type StopReceipt } from "./primary-stop.ts";

const call = (id = "call-1") => ({ toolCallId: id, toolName: "bash", summary: "sleep 180", startedAt: Date.now() });

function setup() {
  const flags = { enabled: true, idle: false, aborting: false };
  const events: string[] = [];
  const records: StopReceipt[] = [];
  const gate = new PrimaryStopController({
    enabled: () => flags.enabled,
    isIdle: () => flags.idle,
    isAborting: () => flags.aborting,
    recordRequest: receipt => { events.push("record"); records.push(receipt); },
    abort: () => { events.push("abort"); flags.aborting = true; },
  });
  return { gate, flags, events, records };
}

test("only an exact, sole active target with a reason can request cancellation", () => {
  const { gate, events, records } = setup();
  assert.equal(gate.requestStop("call-1", "Test").status, "idle");
  const target = gate.toolStarted(call());
  assert.equal(gate.requestStop(target.targetId, "  ").status, "invalid_reason");
  assert.equal(gate.requestStop("older-call", "Test").status, "stale_target");
  gate.toolStarted(call("call-2"));
  assert.equal(gate.requestStop(target.targetId, "Test").status, "parallel_tools");
  assert.deepEqual(events, []);
  gate.toolEnded("call-2", false, false);
  const result = gate.requestStop(target.targetId, "Explicit cancellation test", "reviewer", "openai/gpt-5");
  assert.equal(result.requested, true);
  assert.deepEqual(events, ["record", "abort"], "audit precedes the cancellation side effect");
  assert.equal(records[0]!.advisor, "reviewer");
  assert.equal(records[0]!.model, "openai/gpt-5");
  assert.equal(records[0]!.reason, "Explicit cancellation test");
  assert.equal(records[0]!.target.toolCallId, "call-1");
});

test("paused/off, already-aborting, and stale session targets cannot cancel a later operation", () => {
  const { gate, flags, events } = setup();
  const target = gate.toolStarted(call());
  flags.enabled = false;
  assert.equal(gate.requestStop(target.targetId, "Test").status, "disabled");
  flags.enabled = true;
  flags.aborting = true;
  assert.equal(gate.requestStop(target.targetId, "Test").status, "already_aborting");
  flags.aborting = false;
  gate.reset();
  const next = gate.toolStarted(call()); // Deliberately reuse the provider's ID.
  assert.notEqual(next.targetId, target.targetId);
  assert.equal(gate.requestStop(target.targetId, "Old concern").status, "stale_target");
  assert.deepEqual(events, []);
});

test("one stop is latched across tool completion until the primary run settles", () => {
  const { gate, events } = setup();
  const target = gate.toolStarted(call());
  assert.equal(gate.requestStop(target.targetId, "Reason", "a").requested, true);
  assert.equal(gate.requestStop(target.targetId, "Another reason", "b").status, "stop_pending");
  gate.toolEnded("call-1", true, true);
  assert.equal(gate.requestStop(target.targetId, "Again", "b").status, "stop_pending");
  // A later execution reusing the provider ID cannot overwrite this receipt.
  gate.toolStarted(call());
  gate.toolEnded("call-1", false, false);
  // Nor may overlap between later executions erase an already-observed result.
  gate.toolStarted(call());
  gate.toolStarted(call());
  gate.toolEnded("call-1", false, false);
  gate.toolEnded("call-1", false, false);
  const receipt = gate.settled()!;
  assert.doesNotMatch(formatStopReceipt(receipt), /completion is ambiguous/);
  assert.equal(receipt.toolIsError, true);
  assert.equal(receipt.abortSignalObserved, true);
  assert.ok(receipt.toolEndedAt);
  assert.ok(receipt.settledAt);
  assert.deepEqual(events, ["record", "abort"]);
  assert.equal(gate.settled(), undefined, "only one final receipt");
});

test("reentrant requests cannot issue a second cancellation and acceptance does not imply tool termination", () => {
  let abortCount = 0;
  let targetId = "";
  const gate: PrimaryStopController = new PrimaryStopController({
    enabled: () => true, isIdle: () => false, isAborting: () => false,
    recordRequest: () => { assert.equal(gate.requestStop(targetId, "Competing request").status, "stop_pending"); },
    abort: () => { abortCount++; },
  });
  targetId = gate.toolStarted(call()).targetId;
  assert.equal(gate.requestStop(targetId, "Test").requested, true);
  const receipt = gate.settled()!;
  assert.equal(abortCount, 1);
  assert.equal(receipt.toolEndedAt, undefined);
  assert.match(formatStopReceipt(receipt), /no completion event/);
  assert.match(formatStopReceipt(receipt), /not proof of rollback/);
});

test("overlapping provider IDs block cancellation until settlement, even after the ambiguous calls end", () => {
  const { gate, events } = setup();
  const first = gate.toolStarted(call());
  const second = gate.toolStarted(call());
  assert.notEqual(first.targetId, second.targetId);
  assert.equal(gate.currentTool().activeCount, 2);
  for (const target of [first, second]) {
    assert.equal(gate.requestStop(target.targetId, "Test").status, "ambiguous_tools");
  }
  gate.toolEnded("call-1", false, false);
  assert.equal(gate.currentTool().activeCount, 1);
  assert.equal(gate.requestStop(first.targetId, "Test").status, "ambiguous_tools");
  gate.toolEnded("call-1", false, false);
  const later = gate.toolStarted(call("call-2"));
  assert.equal(gate.requestStop(later.targetId, "Test").status, "ambiguous_tools");
  assert.deepEqual(events, []);
  gate.settled();
  const nextRun = gate.toolStarted(call());
  assert.equal(gate.requestStop(nextRun.targetId, "Explicit new request").requested, true);
});

test("overlapping IDs after a stop request leave the targeted completion ambiguous", () => {
  const { gate } = setup();
  const first = gate.toolStarted(call());
  assert.equal(gate.requestStop(first.targetId, "Test").requested, true);
  gate.toolStarted(call());
  gate.toolEnded("call-1", true, true);
  gate.toolEnded("call-1", false, false);
  const receipt = gate.settled()!;
  assert.equal(receipt.toolEndedAt, undefined, "neither result can be assigned to this exact execution");
  assert.match(formatStopReceipt(receipt), /completion is ambiguous/);
});

test("an abort failure is reported without allowing an immediate retry storm", () => {
  const gate = new PrimaryStopController({
    enabled: () => true, isIdle: () => false, isAborting: () => false,
    recordRequest: () => {}, abort: () => { throw new Error("Abort unavailable"); },
  });
  const target = gate.toolStarted(call());
  assert.equal(gate.requestStop(target.targetId, "Test").status, "failed");
  assert.equal(gate.requestStop(target.targetId, "Retry").status, "stop_pending");
  assert.equal(gate.settled()!.failure, "Abort unavailable");
});

test("the stop gate can cancel a real Pi bash tool before its long sleep finishes", { timeout: 15000 }, async t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const tool = createBashTool(tmpdir(), { exposeSessionEnvironment: false });
  const script = 'console.log("stop-test-ready"); setTimeout(() => console.log("sleep-completed"), 180000)';
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const run = tool.execute("call-1", { command: `${quote(process.execPath)} -e ${quote(script)}`, timeout: 10 }, abort.signal, update => {
    if (update.content.some(block => block.type === "text" && block.text.includes("stop-test-ready"))) ready();
  });
  const outcome = run.then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
  const gate = new PrimaryStopController({
    enabled: () => true, isIdle: () => false, isAborting: () => abort.signal.aborted,
    recordRequest: () => {}, abort: () => abort.abort(),
  });
  const target = gate.toolStarted(call());
  await started;
  assert.equal(gate.requestStop(target.targetId, "Explicit user-requested sleep cancellation test").requested, true);
  const result = await outcome;
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /Command aborted/);
  assert.doesNotMatch(result.error.message, /sleep-completed|timed out/i);
  gate.toolEnded("call-1", true, abort.signal.aborted);
  assert.equal(gate.settled()!.abortSignalObserved, true);
});
