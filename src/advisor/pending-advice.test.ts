import assert from "node:assert/strict";
import test from "node:test";
import { AdviseState, type PendingAdviceAccess, type PendingAdvisorNote } from "./advise-logic.ts";
import { AdvisorInbox } from "./advisor-inbox.ts";
import { makeAdviseTool } from "./advise-tool.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";

function access(inbox: AdvisorInbox, advisor: string): PendingAdviceAccess {
  return {
    list: () => inbox.pendingFor(advisor),
    revise: (id, note) => inbox.revise(advisor, id, note),
    withdraw: id => inbox.withdraw(advisor, id),
  };
}

test("review can revise and withdraw notes before they are released upon completion", () => {
  const sent: PendingAdvisorNote[] = [];
  const state = new AdviseState(note => sent.push(note));
  state.beginUpdate();
  const first = state.submit("Check the tag policy", "concern");
  const second = state.submit("Login is pending", "nit");
  assert.equal(sent.length, 0, "notes are held deferred during active review");
  assert.equal(state.pendingAdvice().length, 2);
  assert.equal(state.revise(first.adviceId!, "The tag policy exists; check its type").changed, true);
  assert.equal(state.withdraw(second.adviceId!).changed, true);
  assert.equal(sent.length, 0, "withdrawn notes are not sent before review settles");
  state.finishUpdate();

  assert.equal(sent.length, 1, "completed review releases accepted notes");
  assert.equal(sent[0]!.adviceId, first.adviceId);
  assert.equal(sent[0]!.note, "The tag policy exists; check its type");
  assert.equal(sent[0]!.severity, "concern");
  assert.equal(state.withdraw(first.adviceId!).changed, false, "handed-off notes cannot be recalled");
  assert.equal(state.revise(first.adviceId!, "Too late").changed, false);
});

test("blockers retain immediate routing while ordinary final-review notes remain editable", () => {
  const sent: PendingAdvisorNote[] = [];
  const state = new AdviseState(note => sent.push(note));
  state.beginUpdate(false);
  const ordinary = state.submit("Useful observation", "concern");
  const blocker = state.submit("Wrong production target", "blocker");
  assert.equal(blocker.delivered, true);
  assert.equal(ordinary.delivered, false);
  assert.deepEqual(sent.map(item => item.note), ["Wrong production target"]);
  state.withdraw(ordinary.adviceId!);
  state.finishUpdate();
  assert.deepEqual(sent.map(item => item.note), ["Wrong production target"]);
});

test("queued advice stays editable across inbox restore but not after dismissal or handoff", () => {
  const inbox = new AdvisorInbox();
  const state = new AdviseState(note => inbox.enqueue({ ...note, advisor: "a" }), access(inbox, "a"));
  const note = state.submit("Earlier concern", "concern");
  const restored = new AdvisorInbox();
  restored.restore(JSON.parse(JSON.stringify(inbox.items)));
  const freshState = new AdviseState(() => {}, access(restored, "a"));
  assert.equal(freshState.pendingAdvice()[0]!.adviceId, note.adviceId);
  assert.equal(freshState.revise(note.adviceId!, "New evidence").changed, true);
  assert.equal(restored.items[0]!.note, "New evidence");
  assert.equal(restored.items[0]!.createdAt, inbox.items[0]!.createdAt);
  restored.clear();
  assert.equal(freshState.withdraw(note.adviceId!).changed, false);
  assert.equal(freshState.revise(note.adviceId!, "Do not resurrect").changed, false);
  assert.deepEqual(restored.items, []);
});

test("queued revisions suppress their replacement text even after user dismissal", () => {
  const inbox = new AdvisorInbox();
  const state = new AdviseState(note => inbox.enqueue({ ...note, advisor: "a" }), access(inbox, "a"));
  const original = state.submit("Initial queued concern", "concern");
  assert.equal(state.revise(original.adviceId!, "Updated queued concern").changed, true);
  assert.equal(state.submit("Updated queued concern", "concern").delivered, false);
  assert.equal(inbox.items.length, 1);
  inbox.clear();
  assert.equal(state.submit("Updated queued concern", "concern").delivered, false);
  assert.equal(inbox.items.length, 0);
});

for (const deferred of [false, true]) {
  test(`${deferred ? "deferred" : "queued"} tool revisions update duplicate history without spending a new-note slot`, async () => {
    const inbox = new AdvisorInbox();
    const guard = new AdvisorEmissionGuard();
    const tools = await makeAdviseTool(note => inbox.enqueue({ ...note, advisor: "a" }), note => guard.accept(note),
      access(inbox, "a"), undefined, undefined, note => guard.remember(note), note => guard.forget(note));
    const invoke = async (tool: typeof tools.tool, args: Record<string, unknown>) =>
      (await tool.execute("fixture", args as any, undefined, undefined, {} as any)).details as any;
    if (deferred) tools.state.beginUpdate(true);
    const original = await invoke(tools.tool, { note: "Initial queued concern", severity: "concern" });
    guard.beginUpdate();
    const revised = await invoke(tools.controlTools.find(tool => tool.name === "revise_advice")!,
      { adviceId: original.adviceId, note: "Updated queued concern" });
    assert.equal(revised.changed, true);
    assert.equal((await invoke(tools.tool, { note: "UPDATED queued concern!", severity: "concern" })).suppressed, true);
    assert.equal((await invoke(tools.tool, { note: "An independent observation", severity: "nit" })).suppressed, false);
    tools.state.beginUpdate(false);
    tools.state.finishUpdate();
    assert.deepEqual(inbox.items.map(note => note.note), ["Updated queued concern", "An independent observation"]);
    inbox.clear();
    guard.beginUpdate();
    assert.equal((await invoke(tools.tool, { note: "Updated queued concern", severity: "concern" })).suppressed, true);
    const rejected = await invoke(tools.controlTools.find(tool => tool.name === "revise_advice")!,
      { adviceId: original.adviceId, note: "Unrecorded revision" });
    assert.equal(rejected.changed, false);
    assert.equal((await invoke(tools.tool, { note: "Unrecorded revision", severity: "nit" })).suppressed, false,
      "a rejected revision does not reserve its proposed text");
  });
}

test("withdrawing a deferred note forgets it so it can be re-raised later", async () => {
  const inbox = new AdvisorInbox();
  const guard = new AdvisorEmissionGuard();
  const tools = await makeAdviseTool(
    note => inbox.enqueue({ ...note, advisor: "a" }),
    note => guard.accept(note),
    access(inbox, "a"),
    undefined,
    undefined,
    note => guard.remember(note),
    note => guard.forget(note),
  );
  const invoke = async (tool: typeof tools.tool, args: Record<string, unknown>) =>
    (await tool.execute("fixture", args as any, undefined, undefined, {} as any)).details as any;

  tools.state.beginUpdate();
  guard.beginUpdate();
  const original = await invoke(tools.tool, { note: "Temporary concern", severity: "concern" });
  assert.equal(original.suppressed, false);

  const withdrawn = await invoke(tools.controlTools.find(tool => tool.name === "withdraw_advice")!, { adviceId: original.adviceId });
  assert.equal(withdrawn.changed, true);
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 0);

  // In a future review update, the withdrawn text is not blocked by emissionGuard
  tools.state.beginUpdate();
  guard.beginUpdate();
  const reRaised = await invoke(tools.tool, { note: "Temporary concern", severity: "concern" });
  assert.equal(reRaised.suppressed, false, "withdrawn note text must not be permanently blocked");
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 1);
});

test("revising a deferred note forgets the old text so it can be re-raised later", async () => {
  const inbox = new AdvisorInbox();
  const guard = new AdvisorEmissionGuard();
  const tools = await makeAdviseTool(
    note => inbox.enqueue({ ...note, advisor: "a" }),
    note => guard.accept(note),
    access(inbox, "a"),
    undefined,
    undefined,
    note => guard.remember(note),
    note => guard.forget(note),
  );
  const invoke = async (tool: typeof tools.tool, args: Record<string, unknown>) =>
    (await tool.execute("fixture", args as any, undefined, undefined, {} as any)).details as any;

  tools.state.beginUpdate();
  guard.beginUpdate();
  const original = await invoke(tools.tool, { note: "Draft wording", severity: "concern" });
  assert.equal(original.suppressed, false);

  const revised = await invoke(tools.controlTools.find(tool => tool.name === "revise_advice")!, {
    adviceId: original.adviceId,
    note: "Final polished wording",
  });
  assert.equal(revised.changed, true);
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0]!.note, "Final polished wording");

  // In a future review update, the old text is not blocked by emissionGuard
  tools.state.beginUpdate();
  guard.beginUpdate();
  const oldTextReUsed = await invoke(tools.tool, { note: "Draft wording", severity: "concern" });
  assert.equal(oldTextReUsed.suppressed, false, "old revised text must not be permanently blocked");
});

test("advisor tools see and edit only their own queued notes", async () => {
  const inbox = new AdvisorInbox();
  const a = await makeAdviseTool(note => inbox.enqueue({ ...note, advisor: "a" }), undefined, access(inbox, "a"));
  const b = await makeAdviseTool(note => inbox.enqueue({ ...note, advisor: "b" }), undefined, access(inbox, "b"));
  const aId = a.state.submit("A's concern", "concern").adviceId!;
  const bId = b.state.submit("B's concern", "concern").adviceId!;
  assert.deepEqual(a.state.pendingAdvice().map(item => item.adviceId), [aId]);
  assert.equal(a.state.withdraw(bId).changed, false);
  assert.equal(a.state.revise(bId, "Not mine").changed, false);
  assert.equal(a.state.withdraw(aId).changed, true);
  assert.deepEqual(b.state.pendingAdvice().map(item => item.note), ["B's concern"]);
});

test("a menu snapshot delivers current text and excludes withdrawn IDs", () => {
  const inbox = new AdvisorInbox();
  const first = inbox.enqueue({ note: "Old text", advisor: "a" });
  const second = inbox.enqueue({ note: "Remove this", advisor: "a" });
  const snapshot = [...inbox.items];
  inbox.revise("a", first.adviceId!, "Revised text");
  inbox.withdraw("a", second.adviceId!);
  const handoff = inbox.select(snapshot.map(note => note.id));
  assert.deepEqual(handoff.map(note => note.note), ["Revised text"]);
  inbox.dismissMany(handoff.map(note => note.id));
  assert.equal(inbox.revise("a", first.adviceId!, "Too late"), false);
  assert.deepEqual(inbox.select(snapshot.map(note => note.id)), []);
});

test("revisions do not spend the new-note budget, and returned snapshots cannot mutate pending notes", () => {
  const guard = new AdvisorEmissionGuard();
  const state = new AdviseState(() => {});
  state.beginUpdate(true);
  assert.equal(guard.accept("Initial note"), true);
  const note = state.submit("Initial note", "concern");
  assert.equal(state.revise(note.adviceId!, "Better wording").changed, true);
  assert.equal(guard.accept("An extra note"), false);
  state.pendingAdvice()[0]!.note = "Mutated copy";
  assert.equal(state.pendingAdvice()[0]!.note, "Better wording");
  assert.equal(state.revise(note.adviceId!, "   ").changed, false);
});
