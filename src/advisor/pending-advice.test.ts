import assert from "node:assert/strict";
import test from "node:test";
import { AdviseState, formatAdvisorBatchContent, type PendingAdviceAccess, type PendingAdvisorNote } from "./advise-logic.ts";
import { AdvisorInbox } from "./advisor-inbox.ts";
import { makeAdviseTool } from "./advise-tool.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";

function access(inbox: AdvisorInbox, advisor: string): PendingAdviceAccess {
  return {
    list: () => inbox.pendingFor(advisor),
    revise: (id, note, shortTitle) => inbox.revise(advisor, id, note, shortTitle),
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
  // Revisions do not consume the new-note budget
  assert.equal(state.revise(note.adviceId!, "Better wording").changed, true);
  assert.equal(guard.accept("Second note"), true);
  assert.equal(guard.accept("Third note"), true);
  assert.equal(guard.accept("Fourth note (over budget)"), false);
  state.pendingAdvice()[0]!.note = "Mutated copy";
  assert.equal(state.pendingAdvice()[0]!.note, "Better wording");
  assert.equal(state.revise(note.adviceId!, "   ").changed, false);
});

test("a shortTitle rides with a note through delivery and rendering", () => {
  const sent: PendingAdvisorNote[] = [];
  const state = new AdviseState(note => sent.push(note));
  state.submit("The early flush path never clears the timer, so a later batch double-delivers", "concern", "Timer leak on early flush");
  assert.equal(sent[0]!.shortTitle, "Timer leak on early flush");
  const rendered = formatAdvisorBatchContent(sent);
  assert.match(rendered, /title="Timer leak on early flush"/);
  assert.match(rendered, /guidance="weigh, don't blindly obey"/);
  const withDisplayProvenance = formatAdvisorBatchContent([{ ...sent[0]!, model: "openai/gpt-5" }]);
  assert.equal(withDisplayProvenance, rendered, "display-only model provenance must not change the primary model's advisory prompt");
});

test("the advise and revise tools accept the ShortTitle key end to end", async () => {
  const inbox = new AdvisorInbox();
  const tools = await makeAdviseTool(note => inbox.enqueue({ ...note, advisor: "a" }));
  const invoke = async (tool: typeof tools.tool, args: Record<string, unknown>) =>
    (await tool.execute("fixture", args as any, undefined, undefined, {} as any)).details as any;

  tools.state.beginUpdate();
  const submitted = await invoke(tools.tool, { note: "Check the dispose path", severity: "concern", ShortTitle: "Unclosed handle" });
  assert.equal(submitted.suppressed, false);
  const revised = await invoke(tools.controlTools.find(tool => tool.name === "revise_advice")!,
    { adviceId: submitted.adviceId, note: "The dispose path leaks the handle", ShortTitle: "Handle leak on dispose" });
  assert.equal(revised.changed, true);
  tools.state.finishUpdate();

  assert.equal(inbox.items[0]!.shortTitle, "Handle leak on dispose");
  assert.equal(inbox.items[0]!.note, "The dispose path leaks the handle");
});

test("revising can replace a shortTitle, and omitting it keeps the current one", () => {
  const inbox = new AdvisorInbox();
  const state = new AdviseState(note => inbox.enqueue({ ...note, advisor: "a" }), access(inbox, "a"));
  const note = state.submit("Earlier concern", "concern", "Old title");
  assert.equal(state.revise(note.adviceId!, "New evidence").changed, true);
  assert.equal(inbox.items[0]!.shortTitle, "Old title", "an omitted title survives a revision");
  assert.equal(state.revise(note.adviceId!, "Newer evidence", "Better title").changed, true);
  assert.equal(inbox.items[0]!.shortTitle, "Better title");
  assert.equal(state.revise(note.adviceId!, "Clearer title", "").changed, true);
  assert.equal(inbox.items[0]!.shortTitle, undefined, "an empty string clears the title");
});

test("update_advice updates queued notes, delivers follow-up on streamed notes, and respects operator dismissal", async () => {
  const inbox = new AdvisorInbox();
  const streamed: PendingAdvisorNote[] = [];
  const guard = new AdvisorEmissionGuard();
  let toolsRef: Awaited<ReturnType<typeof makeAdviseTool>> | undefined;
  const tools = await makeAdviseTool(
    note => {
      if (note.severity === "blocker") {
        streamed.push(note);
        toolsRef?.state.markStreamed(note.adviceId!, note);
      } else {
        inbox.enqueue({ ...note, advisor: "a" });
      }
    },
    note => guard.check(note),
    access(inbox, "a"),
    undefined,
    undefined,
    note => guard.remember(note),
    note => guard.forget(note),
  );
  toolsRef = tools;

  const invoke = async (name: string, args: Record<string, unknown>) => {
    const t = name === "advise" ? tools.tool : tools.controlTools.find(tool => tool.name === name)!;
    return (await t.execute("fixture", args as any, undefined, undefined, {} as any)) as any;
  };

  tools.state.beginUpdate();
  // 1. Submit initial note (deferred in review)
  const res1 = await invoke("advise", { note: "First draft", severity: "concern", ShortTitle: "Draft 1" });
  const adviceId1 = res1.details.adviceId;
  assert.ok(res1.content[0].text.includes("[Review allowance: 1 of 3 used"));

  // 2. update_advice while deferred in review: forgets old draft text and updates in place
  const res2 = await invoke("update_advice", { targetId: adviceId1, note: "Second draft", ShortTitle: "Draft 2" });
  assert.equal(res2.details.outcome, "updated_pending");
  // Proves old draft text was forgotten: guard allows re-submitting "First draft"
  assert.equal(guard.accept("First draft"), true);

  // 3. Complete review: releases note into inbox
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0]!.shortTitle, "Draft 2");

  // 4. update_advice while queued in inbox: updates in place and propagates severity
  const res3 = await invoke("update_advice", { targetId: adviceId1, note: "Inbox draft", ShortTitle: "Inbox title" });
  assert.equal(res3.details.outcome, "updated_pending");
  assert.equal(inbox.items[0]!.shortTitle, "Inbox title");

  // 5. Escalate to blocker: delivers immediately
  const res4 = await invoke("update_advice", { targetId: adviceId1, note: "Critical blocker", severity: "blocker" });
  assert.equal(res4.details.outcome, "delivered_followup");
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0]!.severity, "blocker");
  assert.equal(inbox.items.length, 0, "withdrawn from inbox on blocker escalation");

  // 6. Test dismissal: submit second note into inbox, then operator dismisses it
  tools.state.beginUpdate();
  const res5 = await invoke("advise", { note: "Third note", severity: "nit" });
  const adviceId2 = res5.details.adviceId;
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 1);
  inbox.dismiss(inbox.items[0]!.id);
  assert.equal(inbox.items.length, 0);

  // update_advice on dismissed note must NOT resurrect it
  const res6 = await invoke("update_advice", { targetId: adviceId2, note: "Resurrect attempt" });
  assert.equal(res6.details.outcome, "dismissed");
  assert.equal(inbox.items.length, 0, "remains dismissed");
  assert.equal(streamed.length, 1, "no extra stream delivery");

  // 7. Update an already-streamed note: delivers a follow-up note referencing the original
  tools.state.beginUpdate();
  const res7 = await invoke("update_advice", { targetId: adviceId1, note: "Follow-up refined finding" });
  assert.equal(res7.details.outcome, "delivered_followup");
  assert.equal(streamed.length, 2);
  assert.equal(streamed[1]!.updateOnId, adviceId1);
  assert.equal(streamed[1]!.note, "Follow-up refined finding");

  // 8. Note delivered from inbox to stream (markStreamed): update delivers follow-up referencing it
  guard.beginUpdate();
  tools.state.beginUpdate();
  const res8 = await invoke("advise", { note: "Inbox delivered note", ShortTitle: "Inbox title" });
  const adviceId3 = res8.details.adviceId;
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 1);
  // Simulate user delivering from inbox to stream:
  const item = inbox.takeAll()[0]!;
  tools.state.markStreamed(item.adviceId!, item as PendingAdvisorNote);

  // Now update that delivered note: delivers follow-up referencing it
  guard.beginUpdate();
  tools.state.beginUpdate();
  const res9 = await invoke("update_advice", { targetId: item.adviceId!, note: "Inbox follow-up update" });
  assert.equal(res9.details.outcome, "delivered_followup");
  tools.state.finishUpdate();
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0]!.updateOnId, item.adviceId!);
});
