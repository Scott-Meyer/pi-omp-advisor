import assert from "node:assert/strict";
import test from "node:test";
import { PrimaryInterruptionState } from "./primary-interruption.ts";

test("only a user resume clears the latch; obsolete run signals cannot stop a new run", () => {
  const state = new PrimaryInterruptionState();
  const oldRun = new AbortController();
  const currentRun = new AbortController();
  state.watch(oldRun.signal);
  state.watch(currentRun.signal);
  oldRun.abort();
  assert.equal(state.autoResumeSuppressed, false);
  currentRun.abort();
  assert.equal(state.autoResumeSuppressed, true);
  const nextRun = new AbortController();
  state.watch(nextRun.signal);
  assert.equal(state.autoResumeSuppressed, true, "starting work is not itself a user resume");
  state.resume();
  assert.equal(state.autoResumeSuppressed, false);
  nextRun.abort();
  assert.equal(state.autoResumeSuppressed, true);
  state.reset();
  assert.equal(state.autoResumeSuppressed, false);
});

test("already-aborted signals latch immediately and shutdown detaches without revoking a stop", () => {
  const state = new PrimaryInterruptionState();
  state.watch(AbortSignal.abort());
  assert.equal(state.autoResumeSuppressed, true);
  state.stopWatching();
  assert.equal(state.autoResumeSuppressed, true);
  state.reset();
  const retired = new AbortController();
  state.watch(retired.signal);
  state.stopWatching();
  retired.abort();
  assert.equal(state.autoResumeSuppressed, false);
});
