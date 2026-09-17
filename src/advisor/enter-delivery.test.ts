import assert from "node:assert/strict";
import test from "node:test";
import { attachEnterDelivery, shouldDeliverQueuedOnEnter, type EnterDeliverySignal } from "./enter-delivery.ts";

function signal(overrides: Partial<EnterDeliverySignal> = {}): EnterDeliverySignal {
  return { isSubmitKey: true, editorText: "", idle: true, paused: false, queued: 1, autocompleteOpen: false, submitDisabled: false, ...overrides };
}

test("a submit key on an empty editor in an idle session releases the queued inbox", () => {
  assert.equal(shouldDeliverQueuedOnEnter(signal()), true);
  assert.equal(shouldDeliverQueuedOnEnter(signal({ queued: 3 })), true);
});

test("anything other than the exact empty-Enter case falls through untouched", () => {
  // Not the editor's own submit binding: typed text, paste chunks, kitty release events.
  assert.equal(shouldDeliverQueuedOnEnter(signal({ isSubmitKey: false })), false);
  // Autocomplete is open: Enter means "accept the completion".
  assert.equal(shouldDeliverQueuedOnEnter(signal({ autocompleteOpen: true })), false);
  // pi disabled submission (its own gate, e.g. compaction flows).
  assert.equal(shouldDeliverQueuedOnEnter(signal({ submitDisabled: true })), false);
  // Not idle: Enter belongs to the running agent.
  assert.equal(shouldDeliverQueuedOnEnter(signal({ idle: false })), false);
  // Advisor paused: delivery is opt-in, same as the inbox's Deliver button.
  assert.equal(shouldDeliverQueuedOnEnter(signal({ paused: true })), false);
  // Nothing queued: a bare Enter must stay pi's own no-op.
  assert.equal(shouldDeliverQueuedOnEnter(signal({ queued: 0 })), false);
  // The user is composing: whitespace-only still counts as an empty message,
  // but a single character is a real prompt.
  assert.equal(shouldDeliverQueuedOnEnter(signal({ editorText: "   \n " })), true, "whitespace-only editor is still empty");
  assert.equal(shouldDeliverQueuedOnEnter(signal({ editorText: "go" })), false);
});

/** A minimal editor stand-in exercising the real interception wrapper. */
function stubEditor(opts: { text?: string; autocomplete?: boolean; disableSubmit?: boolean } = {}) {
  const calls: string[] = [];
  const deliver: string[] = [];
  const editor = {
    handleInput: (data: string) => { calls.push(data); },
    getText: () => opts.text ?? "",
    isShowingAutocomplete: () => opts.autocomplete ?? false,
    disableSubmit: opts.disableSubmit ?? false,
  };
  const wrapped = attachEnterDelivery(editor, {
    isSubmitKey: data => data === "\r",
    state: () => ({ idle: true, paused: false, queued: inboxQueued }),
    deliver: () => { deliver.push("delivered"); },
  });
  let inboxQueued = 1;
  return { wrapped, calls, deliver, setQueued: (n: number) => { inboxQueued = n; } };
}

test("the editor wrapper delivers on the exact case and consumes the key", () => {
  const { wrapped, calls, deliver } = stubEditor();
  wrapped.handleInput("\r");
  assert.deepEqual(deliver, ["delivered"], "the queued inbox is released");
  assert.deepEqual(calls, [], "the original handler never sees the consumed Enter");
});

test("the editor wrapper passes through everything else", () => {
  // Autocomplete open: Enter must reach the editor to accept the completion.
  const ac = stubEditor({ autocomplete: true });
  ac.wrapped.handleInput("\r");
  assert.deepEqual(ac.deliver, []);
  assert.deepEqual(ac.calls, ["\r"]);

  // Real text: Enter is an actual prompt submission.
  const composing = stubEditor({ text: "go" });
  composing.wrapped.handleInput("\r");
  assert.deepEqual(composing.deliver, []);

  // Nothing queued: a bare Enter stays pi's no-op, untouched.
  const empty = stubEditor();
  empty.setQueued(0);
  empty.wrapped.handleInput("\r");
  assert.deepEqual(empty.deliver, []);
  assert.deepEqual(empty.calls, ["\r"]);

  // Other input is never intercepted.
  const typing = stubEditor();
  for (const data of ["a", "\u001b[A", "some pasted\rtext"]) {
    typing.wrapped.handleInput(data);
  }
  assert.deepEqual(typing.deliver, []);
  assert.deepEqual(typing.calls, ["a", "\u001b[A", "some pasted\rtext"]);
});
