import assert from "node:assert/strict";
import test from "node:test";
import { RequestedBooleanState, SerializedTransition } from "./serialized-transition.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test("does not expose a later state until the preceding async transition settles", async () => {
  const transitions = new SerializedTransition();
  const pauseFinished = deferred();
  const events: string[] = [];

  const pause = transitions.run(async () => {
    events.push("pause:start");
    await pauseFinished.promise;
    events.push("pause:done");
  });
  const resume = transitions.run(() => {
    events.push("resume");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["pause:start"]);

  pauseFinished.resolve();
  await Promise.all([pause, resume]);
  assert.deepEqual(events, ["pause:start", "pause:done", "resume"]);
});

test("a failed transition does not prevent a later requested state", async () => {
  const transitions = new SerializedTransition();
  const failure = transitions.run(() => {
    throw new Error("pause failed");
  });
  const resumed = transitions.run(() => "resumed");

  await assert.rejects(failure, /pause failed/);
  assert.equal(await resumed, "resumed");
});

test("rejecting a request does not overwrite a newer requested state", () => {
  const state = new RequestedBooleanState(false);

  state.request(true);
  state.reject(true);
  assert.equal(state.requested, false);

  state.request(true);
  state.request(false);
  state.reject(true);
  assert.equal(state.requested, false);
});

test("two rapid toggle calls apply pause then resume rather than enqueueing pause twice", async () => {
  const state = new RequestedBooleanState(false);
  const transitions = new SerializedTransition();
  const pauseFinished = deferred();
  const applied: boolean[] = [];

  const toggle = () => {
    const requested = state.toggleRequest();
    return transitions.run(async () => {
      if (requested) {
        state.apply(true);
        applied.push(true);
        await pauseFinished.promise;
      } else {
        state.apply(false);
        applied.push(false);
      }
    });
  };

  const pause = toggle();
  const resume = toggle();
  await Promise.resolve();

  assert.deepEqual(applied, [true]);
  assert.equal(state.applied, true);
  assert.equal(state.requested, false, "the second shortcut must latch resume before pause finishes");

  pauseFinished.resolve();
  await Promise.all([pause, resume]);
  assert.deepEqual(applied, [true, false]);
  assert.equal(state.applied, false);
  assert.equal(state.requested, false);
});
