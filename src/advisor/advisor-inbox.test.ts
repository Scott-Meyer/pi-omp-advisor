import assert from "node:assert/strict";
import test from "node:test";
import { AdvisorInbox } from "./advisor-inbox.ts";

test("queues preserved advisories in arrival order with stable ids", () => {
  const inbox = new AdvisorInbox();

  const first = inbox.enqueue({ note: "First", severity: "concern", advisor: "security" });
  const second = inbox.enqueue({ note: "Second" });

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.deepEqual(inbox.items, [first, second]);
});

test("dismiss removes only the selected queued advisory", () => {
  const inbox = new AdvisorInbox();
  const first = inbox.enqueue({ note: "First" });
  const second = inbox.enqueue({ note: "Second", severity: "blocker" });

  assert.equal(inbox.dismiss(first.id), true);
  assert.equal(inbox.dismiss(first.id), false);
  assert.deepEqual(inbox.items, [second]);
});

test("dismissMany removes only the confirmed snapshot", () => {
  const inbox = new AdvisorInbox();
  const first = inbox.enqueue({ note: "First" });
  const second = inbox.enqueue({ note: "Second" });
  const arrivedLater = inbox.enqueue({ note: "Arrived later" });

  assert.equal(inbox.dismissMany([first.id, second.id]), 2);
  assert.deepEqual(inbox.items, [arrivedLater]);
});

test("restores persisted items without reusing ids", () => {
  const inbox = new AdvisorInbox();
  inbox.restore([
    { id: 4, note: "First" },
    { id: 7, note: "Second", severity: "concern" },
  ]);

  assert.deepEqual(
    inbox.items.map(item => item.id),
    [4, 7],
  );
  assert.equal(inbox.enqueue({ note: "Later" }).id, 8);
});

test("takeAll drains the inbox without reusing ids", () => {
  const inbox = new AdvisorInbox();
  const first = inbox.enqueue({ note: "First" });

  assert.deepEqual(inbox.takeAll(), [first]);
  assert.deepEqual(inbox.items, []);
  assert.equal(inbox.enqueue({ note: "Later" }).id, 2);
});

test("clear dismisses every queued advisory", () => {
  const inbox = new AdvisorInbox();
  inbox.enqueue({ note: "First" });
  inbox.enqueue({ note: "Second" });

  inbox.clear();

  assert.deepEqual(inbox.items, []);
});
