import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type StopReason } from "@earendil-works/pi-ai";
import { PrimaryInterruptionState } from "./primary-interruption.ts";
import type { createAgentSession, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AdvisorOrchestrator, type OrchestratorHost } from "./orchestrator.ts";
import { AdvisorInbox } from "./advisor-inbox.ts";
import { ADVISOR_COMMUNICATION_TOOLS } from "./advise-tool.ts";
import { ADVISOR_STOP_TOOLS } from "./stop-tools.ts";
import type { PrimaryStopAccess } from "./primary-stop.ts";
import { discoverAdvisorConfigs } from "./watchdog-config.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

type Review = (text: string, call: (name: string, args?: Record<string, unknown>) => Promise<any>, signal: AbortSignal) => Promise<void | StopReason>;

// Substitute only the model/session boundary: real batching, tools, state,
// prompt assembly, resource isolation and host inbox remain in the exercise.
async function harness(t: TestContext, review: Review, options?: { stop?: PrimaryStopAccess; contextTokens?: number; includePrimaryThinking?: boolean; syncBacklog?: unknown; maxBehind?: number; flushTimeoutMs?: number; primary?: { isStreaming(): boolean; isAborting(): boolean; isAutoResumeSuppressed(): boolean } }) {
  const cwd = await mkdtemp(join(tmpdir(), "advisor-orchestrator-"));
  const agentDir = join(cwd, "agent-config");
  await mkdir(agentDir);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const inbox = new AdvisorInbox();
  const preserved = deferred();
  const sent: { content: string; details: unknown; options: Parameters<OrchestratorHost["sendCustom"]>[2] }[] = [];
  const reviewFailures: unknown[] = [];
  // Production catches model errors. Test assertions inside a model-boundary
  // callback still have to fail the test, not become a harmless advisor error.
  t.after(() => {
    if (reviewFailures.length > 0) throw new AggregateError(reviewFailures, "Model-boundary test assertions failed");
  });
  const host: OrchestratorHost = {
    sendCustom: (content, details, options) => { sent.push({ content, details, options }); },
    preserveAdvice: note => { inbox.enqueue(note); preserved.resolve(); },
    pendingAdvice: owner => inbox.pendingFor(owner),
    reviseAdvice: (owner, id, note) => inbox.revise(owner, id, note),
    withdrawAdvice: (owner, id) => inbox.withdraw(owner, id),
    currentTool: () => options?.stop?.currentTool() ?? { status: "idle", activeCount: 0 },
    requestStop: (_advisor, id, reason) => options?.stop?.requestStop(id, reason) ?? { requested: false, status: "disabled", message: "No stop grant" },
    isStreaming: () => options?.primary?.isStreaming() ?? false,
    isAborting: () => options?.primary?.isAborting() ?? false,
    isAutoResumeSuppressed: () => options?.primary?.isAutoResumeSuppressed() ?? false,
    hasQueuedWork: () => false,
    setStatus: () => {},
  };
  let sessionCount = 0;
  const createSession: typeof createAgentSession = async options => {
    sessionCount++;
    assert.ok(options?.customTools);
    for (const name of ADVISOR_COMMUNICATION_TOOLS) {
      assert.ok(options.tools?.includes(name), `${name} must survive the tool allowlist`);
      assert.ok(options.customTools.some(tool => tool.name === name));
    }
    for (const name of ADVISOR_STOP_TOOLS) {
      const granted: boolean = options.tools?.includes("request_stop") ?? false;
      assert.equal(options.customTools.some(tool => tool.name === name), granted, `${name} requires the explicit stop grant`);
      if (granted) assert.ok(options.tools?.includes(name));
    }
    const tools = options.customTools;
    const state = {
      messages: [] as AgentMessage[], isStreaming: false,
      systemPrompt: options.resourceLoader?.getSystemPrompt() ?? "",
      tools, model: { contextWindow: 128_000 },
    };
    let controller = new AbortController();
    let inFlight = Promise.resolve();
    const listeners = new Set<(event: AgentEvent, signal: AbortSignal) => void>();
    const session = {
      // Faithful to AgentSession: its wrapper flag is not set by Agent.prompt.
      get isStreaming() { return false; },
      agent: {
        state,
        transformContext: undefined as Agent["transformContext"],
        subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        abort() { controller.abort(); },
        waitForIdle() { return inFlight; },
        prompt(messages: AgentMessage[]): Promise<void> {
          controller = new AbortController();
          state.isStreaming = true;
          for (const listener of listeners) listener({ type: "agent_start" }, controller.signal);
          state.messages.push(...messages);
          inFlight = (async () => {
            try {
              const view: AgentMessage[] = await session.agent.transformContext?.(state.messages, controller.signal) ?? state.messages;
              const text = view.map(message => JSON.stringify(message)).join("\n");
              const result = await review(text, async (name, args = {}) => {
                const tool = tools.find(candidate => candidate.name === name)!;
                assert.ok(tool, `tool ${name} registered`);
                const result = await tool.execute("test-call", args, controller.signal, undefined, {} as ExtensionContext);
                return result.details;
              }, controller.signal).catch(error => {
                reviewFailures.push(error);
                throw error;
              });
              state.messages.push({ role: "assistant", content: [], stopReason: controller.signal.aborted ? "aborted" : result ?? "stop" } as unknown as AgentMessage);
            } finally {
              state.isStreaming = false;
            }
          })();
          return inFlight;
        },
      },
      // Wrapper idle is already true, so this signals without awaiting the Agent.
      async abort() { controller.abort(); },
      dispose() { controller.abort(); },
    };
    return { session } as unknown as Awaited<ReturnType<typeof createAgentSession>>;
  };
  await writeFile(join(cwd, "WATCHDOG.yml"), [
    "main: true",
    ...(options?.maxBehind !== undefined ? [`maxBehind: ${options.maxBehind}`] : []),
    ...(options?.flushTimeoutMs !== undefined ? [`flushTimeoutMs: ${options.flushTimeoutMs}`] : []),
    "advisors:", "  - name: reviewer",
    ...(options?.stop ? ["    tools: [read, grep, glob, request_stop]"] : []),
    ...(options?.contextTokens !== undefined ? [`    contextTokens: ${options.contextTokens}`] : []),
    ...(options?.includePrimaryThinking !== undefined ? [`    includePrimaryThinking: ${options.includePrimaryThinking}`] : []),
    ...(options?.syncBacklog !== undefined
      ? [typeof options.syncBacklog === "object" && options.syncBacklog !== null
          ? `syncBacklog:\n  pauseAt: ${(options.syncBacklog as { pauseAt: number }).pauseAt}\n  resumeAt: ${(options.syncBacklog as { resumeAt: number }).resumeAt}`
          : `syncBacklog: ${options.syncBacklog}`]
      : []), "",
  ].join("\n"));
  const discovered = await discoverAdvisorConfigs(cwd, agentDir);
  assert.equal(discovered.advisors[0]?.tools?.includes("request_stop") ?? false, Boolean(options?.stop), "the explicit YAML grant must survive discovery");
  const orchestrator = new AdvisorOrchestrator(host, createSession);
  await orchestrator.start(discovered, { cwd } as ExtensionContext, {} as ModelRuntime, agentDir);
  t.after(() => orchestrator.disposeAll());
  return { orchestrator, inbox, sent, whenPreserved: preserved.promise, sessionCount: () => sessionCount };
}

function update(orchestrator: AdvisorOrchestrator, final: boolean) {
  orchestrator.onMessage({ role: "user", content: "A new observed step", timestamp: Date.now() });
  orchestrator.onTurnEnd();
  if (final) orchestrator.onAgentSettled();
  else orchestrator.onTurnStart();
}

test("real review tools revise/withdraw deferred notes before final review releases them", async t => {
  let turn = 0;
  let firstId = "";
  let secondId = "";
  const reviewingFinal = deferred();
  const finishFinal = deferred();
  const { orchestrator, inbox } = await harness(t, async (text, call) => {
    turn++;
    if (turn === 1) firstId = (await call("advise", { note: "Check tag policy", severity: "concern" })).adviceId;
    else if (turn === 2) secondId = (await call("advise", { note: "Login pending", severity: "concern" })).adviceId;
    else {
      assert.match(text, /Your pending advice/);
      const pending = await call("pending_advice");
      assert.deepEqual(pending.pending.map((note: any) => note.adviceId), [firstId, secondId]);
      assert.equal((await call("revise_advice", { adviceId: firstId, note: "Check tag rule type" })).changed, true);
      assert.equal((await call("withdraw_advice", { adviceId: secondId })).changed, true);
      reviewingFinal.resolve();
      await finishFinal.promise;
    }
  });
  update(orchestrator, false);
  assert.equal(await orchestrator.drainForExit(1000), true);
  update(orchestrator, false);
  assert.equal(await orchestrator.drainForExit(1000), true);
  update(orchestrator, true);
  await reviewingFinal.promise;
  assert.equal(inbox.items.length, 0, "still held while final review is running");
  finishFinal.resolve();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.deepEqual(inbox.items.map(note => note.note), ["Check tag rule type"]);
  assert.equal(inbox.items[0]!.adviceId, firstId);
});

test("pending IDs survive a model-context rebuild and remain withdrawable", async t => {
  let id = "";
  let turn = 0;
  const { orchestrator, inbox, sessionCount } = await harness(t, async (text, call) => {
    if (++turn === 1) id = (await call("advise", { note: "Still investigating", severity: "concern" })).adviceId;
    else {
      assert.match(text, /model context was rebuilt/);
      const pending = await call("pending_advice");
      assert.equal(pending.pending[0].adviceId, id);
      assert.equal((await call("withdraw_advice", { adviceId: id })).changed, true);
    }
  });
  update(orchestrator, false);
  await orchestrator.drainForExit(1000);
  await orchestrator.resetRuntimesOnly();
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(sessionCount(), 2);
  assert.deepEqual(inbox.items, []);
});

test("pausing during final review does not release notes even when an aborted prompt resolves", async t => {
  let turn = 0;
  const reviewingFinal = deferred();
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call, signal) => {
    if (++turn === 1) await call("advise", { note: "Needs a second look", severity: "concern" });
    else if (turn === 2) {
      reviewingFinal.resolve();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } else {
      const pending = await call("pending_advice");
      assert.equal(pending.pending[0].note, "Needs a second look");
      await call("withdraw_advice", { adviceId: pending.pending[0].adviceId });
    }
  });
  update(orchestrator, false);
  await orchestrator.drainForExit(1000);
  update(orchestrator, true);
  await reviewingFinal.promise;
  await orchestrator.setPaused(true);
  assert.deepEqual(inbox.items, []);
  assert.deepEqual(sent, []);
  await orchestrator.setPaused(false);
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.deepEqual(inbox.items, []);
});

test("a provider error that resolves normally does not count as final review", async t => {
  t.mock.method(console, "error", () => {});
  const recovered = deferred();
  let turn = 0;
  const { orchestrator, inbox } = await harness(t, async (_text, call) => {
    turn++;
    if (turn === 1) await call("advise", { note: "Check before shipping", severity: "concern" });
    else if (turn === 2 || turn === 3) return "error";
    else {
      const pending = await call("pending_advice");
      assert.equal(pending.pending.length, 1, "failed review retains its editable note");
      await call("withdraw_advice", { adviceId: pending.pending[0].adviceId });
      recovered.resolve();
    }
  }, { includePrimaryThinking: true });
  update(orchestrator, false);
  await orchestrator.drainForExit(1000);
  update(orchestrator, true);
  await orchestrator.drainForExit(1000);
  assert.equal(turn, 3, "existing thinking-stripped retry was exercised");
  assert.equal(inbox.items.length, 0);
  update(orchestrator, true);
  await recovered.promise;
  assert.equal(turn, 4);
  assert.equal(inbox.items.length, 0);
});

for (const action of ["pause/resume", "reset"] as const) {
  test(`${action} waits for the directly prompted Agent before proceeding`, { timeout: 5000 }, async t => {
    let turn = 0;
    let id = "";
    const reviewingFinal = deferred();
    const aborted = deferred();
    const finishCleanup = deferred();
    t.after(() => finishCleanup.resolve());
    const { orchestrator, inbox, sent, sessionCount } = await harness(t, async (_text, call, signal) => {
      turn++;
      if (turn === 1) id = (await call("advise", { note: "Check this assumption", severity: "concern" })).adviceId;
      else if (turn === 2) {
        reviewingFinal.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted.resolve();
        await finishCleanup.promise;
      } else {
        const pending = await call("pending_advice");
        assert.equal(pending.pending[0].adviceId, id);
        await call("withdraw_advice", { adviceId: id });
      }
    });
    update(orchestrator, false);
    await orchestrator.drainForExit(1000);
    update(orchestrator, true);
    await reviewingFinal.promise;

    const transition = action === "reset"
      ? orchestrator.resetRuntimesOnly()
      : Promise.all([orchestrator.setPaused(true), orchestrator.setPaused(false)]);
    let transitioned = false;
    const completed = transition.then(() => { transitioned = true; });
    await aborted.promise;
    assert.equal(transitioned, false, "Agent cancellation cleanup is still in flight");
    assert.equal(sessionCount(), 1, "reset cannot build the replacement session early");
    assert.equal(inbox.items.length, 0);
    assert.equal(sent.length, 0);
    finishCleanup.resolve();
    await completed;
    assert.equal(inbox.items.length, 0, "the cancelled final review cannot flush after resume/reset");
    update(orchestrator, true);
    assert.equal(await orchestrator.drainForExit(1000), true);
    assert.equal(inbox.items.length, 0);
    assert.equal(sessionCount(), action === "reset" ? 2 : 1);
  });
}

for (const includePrimaryThinking of [undefined, true, false]) {
  test(`primary reasoning is ${includePrimaryThinking === true ? "included on explicit opt-in" : "excluded"} (${String(includePrimaryThinking)})`, async t => {
    let checked = false;
    const { orchestrator } = await harness(t, async text => {
      checked = true;
      assert.match(text, /VISIBLE_ACTION/);
      assert.equal(text.includes("PRIMARY_REASONING_MARKER"), includePrimaryThinking === true);
    }, { includePrimaryThinking });
    orchestrator.onMessage({ role: "assistant", content: [{ type: "thinking", thinking: "PRIMARY_REASONING_MARKER" }, { type: "text", text: "VISIBLE_ACTION" }], stopReason: "stop" } as unknown as AgentMessage);
    orchestrator.onTurnEnd();
    orchestrator.onAgentSettled();
    assert.equal(await orchestrator.drainForExit(1000), true);
    assert.equal(checked, true);
  });
}

test("pending advice survives history eviction and remains withdrawable", async t => {
  let id = "";
  let turn = 0;
  const { orchestrator, inbox } = await harness(t, async (text, call) => {
    turn++;
    if (turn === 1) id = (await call("advise", { note: "Keep this pending concern", severity: "concern" })).adviceId;
    else if (turn === 3) {
      assert.doesNotMatch(text, /OLD_OBSERVATION/);
      const pending = await call("pending_advice");
      assert.equal(pending.pending[0].adviceId, id);
      await call("withdraw_advice", { adviceId: id });
    }
  }, { contextTokens: 8192 });
  orchestrator.onMessage({ role: "user", content: "OLD_OBSERVATION", timestamp: 1 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();
  await orchestrator.drainForExit(1000);
  orchestrator.onMessage({ role: "user", content: "A new investigation: " + "x".repeat(50_000), timestamp: 2 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();
  await orchestrator.drainForExit(1000);
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(turn, 3);
  assert.equal(inbox.items.length, 0);
  const status = orchestrator.statusOverview()[0]!;
  assert.equal(status.context?.limitTokens, 8192);
  assert.ok(status.context!.estimatedTokens <= 8192);
  assert.equal(status.context?.trimmed, true);
});

test("stop-enabled advisors see a tool start before its result or turn end", async t => {
  const reviewed = deferred();
  const activity = { targetId: "execution-1", toolCallId: "primary-sleep-1", toolName: "bash", summary: "sleep 180", startedAt: Date.now() };
  const calls: string[] = [];
  const { orchestrator } = await harness(t, async (text, call) => {
    assert.match(text, /Primary tool activity/);
    assert.match(text, /primary-sleep-1/);
    const current = await call("current_tool");
    assert.equal(current.tool.toolCallId, activity.toolCallId);
    const result = await call("request_stop", { targetId: activity.targetId, reason: "Explicit user-requested sleep cancellation test" });
    assert.equal(result.requested, true);
    reviewed.resolve();
  }, {
    stop: {
      currentTool: () => ({ status: "ready", tool: activity, activeCount: 1 }),
      requestStop: (id, reason) => {
        assert.equal(reason, "Explicit user-requested sleep cancellation test");
        calls.push(id);
        return { requested: true, status: "requested", message: "Cancellation requested, not confirmed" };
      },
    },
  });
  orchestrator.onMessage({ role: "user", content: "Observe this call and stop the diagnostic sleep", timestamp: Date.now() });
  orchestrator.onToolStart(activity);
  await reviewed.promise;
  assert.deepEqual(calls, [activity.targetId]);
  assert.equal(await orchestrator.drainForExit(1000), true);
});

for (const reason of ["length", "deferred"] as const) {
  test(`${reason} responses retain notes until a genuinely completed review`, async t => {
    t.mock.method(console, "error", () => {});
    let turn = 0;
    let id = "";
    const { orchestrator, inbox, whenPreserved } = await harness(t, async (_text, call) => {
      turn++;
      if (turn === 1) id = (await call("advise", { note: "Reconsider this", severity: "concern" })).adviceId;
      else if (turn === 2 || turn === 3) return reason;
      else {
        const pending = await call("pending_advice");
        assert.equal(pending.pending[0].adviceId, id);
        // Successful reconsideration retains this note for normal release.
      }
    }, { includePrimaryThinking: true });
    update(orchestrator, false);
    await orchestrator.drainForExit(1000);
    update(orchestrator, true);
    await orchestrator.drainForExit(1000);
    assert.equal(turn, 3);
    assert.equal(inbox.items.length, 0);
    update(orchestrator, true);
    await whenPreserved;
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0]!.adviceId, id);
    assert.equal(inbox.items[0]!.note, "Reconsider this");
  });
}

for (const severity of [undefined, "nit", "concern"] as const) {
  test(`late ${severity ?? "default"} notes can be read, dismissed and cleared without reaching the primary`, async t => {
    const ids: string[] = [];
    let turn = 0;
    const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
      if (++turn <= 2) ids.push((await call("advise", { note: `Late observation ${turn}`, severity })).adviceId);
      else assert.equal((await call("pending_advice")).total, 0, "user-discarded notes do not return");
    });
    for (let i = 0; i < 2; i++) {
      update(orchestrator, true);
      assert.equal(await orchestrator.drainForExit(1000), true);
    }
    assert.deepEqual(inbox.items.map(note => note.adviceId), ids);
    assert.deepEqual(inbox.items.map(note => note.note), ["Late observation 1", "Late observation 2"]);
    assert.deepEqual(sent, []);
    assert.equal(inbox.dismiss(inbox.items[0]!.id), true);
    assert.deepEqual(inbox.items.map(note => note.adviceId), [ids[1]]);
    inbox.clear();
    update(orchestrator, true);
    assert.equal(await orchestrator.drainForExit(1000), true);
    assert.equal(inbox.items.length, 0);
    assert.equal(sent.length, 0);
  });
}

test("revision duplicate tracking stays wired before and after a model-context rebuild", async t => {
  let turn = 0;
  let id = "";
  const { orchestrator, inbox, sessionCount } = await harness(t, async (_text, call) => {
    if (++turn === 1) {
      id = (await call("advise", { note: "Original observation", severity: "concern" })).adviceId;
      return;
    }
    const text = `Updated observation ${turn}`;
    assert.equal((await call("revise_advice", { adviceId: id, note: text })).changed, true);
    assert.equal((await call("advise", { note: text.toUpperCase(), severity: "concern" })).suppressed, true);
    assert.equal((await call("advise", { note: `Independent observation ${turn}`, severity: "nit" })).suppressed, false);
  });
  for (let step = 1; step <= 3; step++) {
    if (step === 3) await orchestrator.resetRuntimesOnly();
    update(orchestrator, true);
    assert.equal(await orchestrator.drainForExit(1000), true);
  }
  assert.equal(sessionCount(), 2);
  assert.deepEqual(inbox.items.map(note => note.note), ["Updated observation 3", "Independent observation 2", "Independent observation 3"]);
  assert.equal(inbox.items[0]!.adviceId, id);
});

test("a real primary abort stays stopped after signal cleanup and advisor reconstruction", async t => {
  const interruption = new PrimaryInterruptionState();
  const primary: Agent = new Agent({
    streamFn: model => {
      primary.abort();
      const message: AssistantMessage = {
        role: "assistant", content: [], stopReason: "stop", api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  const detach = primary.subscribe(event => { if (event.type === "agent_start") interruption.watch(primary.signal); });
  t.after(() => { detach(); interruption.stopWatching(); });
  await primary.prompt("A primary operation the user stops.");
  assert.equal(primary.signal, undefined, "the transient signal is gone after settlement");
  assert.equal(interruption.autoResumeSuppressed, true);

  let note = 0;
  // The host owns the stop, so even an advisor created after the abort cannot
  // undo it by initializing fresh model/runtime state.
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    await call("advise", { note: `Late blocker ${++note}`, severity: "blocker" });
  }, { primary: {
    isStreaming: () => primary.state.isStreaming,
    isAborting: () => primary.signal?.aborted === true,
    isAutoResumeSuppressed: () => interruption.autoResumeSuppressed,
  } });
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(inbox.items.length, 1);
  assert.equal(sent.length, 0, "the late blocker did not restart the stopped primary");
  inbox.clear();
  interruption.resume();
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(inbox.items.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.options.triggerTurn, true, "an explicit resume restores normal blocker routing");
});

for (const boundary of ["completion", "abort"] as const) {
  test(`a queued aside is rechecked if primary ${boundary} occurs before handoff`, async t => {
    let streaming = true;
    const interruption = new PrimaryInterruptionState();
    const controller = new AbortController();
    interruption.watch(controller.signal);
    t.after(() => interruption.stopWatching());
    const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
      await call("advise", { note: "Queued before the primary stopped", severity: "nit" });
    }, { primary: {
      isStreaming: () => streaming,
      isAborting: () => controller.signal.aborted,
      isAutoResumeSuppressed: () => interruption.autoResumeSuppressed,
    } });
    const enqueued = deferred();
    let release!: () => void;
    // Hold the public scheduler boundary, not private orchestrator state.
    t.mock.method(globalThis, "queueMicrotask", (callback: () => void) => { release = callback; enqueued.resolve(); });
    update(orchestrator, true);
    await enqueued.promise;
    assert.equal(inbox.items.length, 0);
    assert.equal(sent.length, 0);
    if (boundary === "abort") controller.abort();
    else streaming = false;
    release();
    assert.equal(await orchestrator.drainForExit(1000), true);
    assert.equal(inbox.items.length, 1);
    assert.equal(sent.length, 0);
    inbox.clear();
    assert.equal(inbox.items.length, 0);
  });
}

test("waitForCatchup pauses when queue reaches pauseAt and resumes when drained to resumeAt", async t => {
  const allowTurn1 = deferred();
  const allowTurn2 = deferred();
  const allowTurn3 = deferred();
  let turnCount = 0;

  const { orchestrator } = await harness(t, async () => {
    turnCount++;
    if (turnCount === 1) await allowTurn1.promise;
    else if (turnCount === 2) await allowTurn2.promise;
    else if (turnCount === 3) await allowTurn3.promise;
  }, {
    syncBacklog: { pauseAt: 3, resumeAt: 1 },
  });

  // Turn 1 starts advisor processing batch 1 (which hangs on allowTurn1)
  orchestrator.onMessage({ role: "user", content: "turn 1", timestamp: 1 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  // Turn 2 is dispatched into advisor.queue (length 1)
  orchestrator.onMessage({ role: "user", content: "turn 2", timestamp: 2 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  // Queue is length 1; pauseAt is 3 -> waitForCatchup should NOT block
  let catchupReturned = false;
  let p = orchestrator.waitForCatchup().then(() => { catchupReturned = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(catchupReturned, true, "queue length 1 < pauseAt 3, so must not block");
  await p;

  // Turn 3 is dispatched into advisor.queue (length 2)
  orchestrator.onMessage({ role: "user", content: "turn 3", timestamp: 3 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  // Queue is length 2; pauseAt is 3 -> waitForCatchup still does NOT block
  catchupReturned = false;
  p = orchestrator.waitForCatchup().then(() => { catchupReturned = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(catchupReturned, true, "queue length 2 < pauseAt 3, so must not block");
  await p;

  // Turn 4 is dispatched into advisor.queue (length 3) -> hits pauseAt 3!
  orchestrator.onMessage({ role: "user", content: "turn 4", timestamp: 4 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  catchupReturned = false;
  p = orchestrator.waitForCatchup().then(() => { catchupReturned = true; });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(catchupReturned, false, "queue length 3 >= pauseAt 3, so MUST block");

  // Let turn 1 complete. Advisor pops turn 2 from queue. Queue length is now 2.
  // Since resumeAt is 1, queue length 2 > 1, so waitForCatchup must STILL be blocked!
  allowTurn1.resolve();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(catchupReturned, false, "queue length 2 > resumeAt 1, so must remain blocked");

  // Let turn 2 complete. Advisor pops turn 3 from queue. Queue length is now 1.
  // Since resumeAt is 1, queue length is now <= 1, so waitForCatchup should unblock!
  allowTurn2.resolve();
  await p;
  assert.equal(catchupReturned, true, "queue length reached resumeAt 1, so unblocked");

  // Clean up
  allowTurn3.resolve();
  await orchestrator.drainForExit(1000);
});

test("coalesces waiting queue items when backlog reaches maxBehind", async t => {
  const allowTurn1 = deferred();
  const allowTurn2 = deferred();
  const allowTurn3 = deferred();
  let turnCount = 0;
  const reviewedBatchSizes: number[] = [];

  const { orchestrator } = await harness(t, async (text) => {
    turnCount++;
    const count = (text.match(/message-\d+/g) || []).length;
    reviewedBatchSizes.push(count);
    if (turnCount === 1) await allowTurn1.promise;
    else if (turnCount === 2) await allowTurn2.promise;
    else if (turnCount === 3) await allowTurn3.promise;
  }, {
    maxBehind: 2,
  });

  // Turn 1: advisor starts processing batch 1 (which hangs on allowTurn1)
  orchestrator.onMessage({ role: "user", content: "message-1", timestamp: 1 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  // Turn 2: queued as item 1 (queue length 1)
  orchestrator.onMessage({ role: "user", content: "message-2", timestamp: 2 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  // Turn 3: queued as item 2 (queue length 2 = maxBehind)
  orchestrator.onMessage({ role: "user", content: "message-3", timestamp: 3 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  let overview = orchestrator.statusOverview()[0]!;
  assert.equal(overview.backlog, 2);
  assert.equal(overview.backlogMessages, 2);

  // Turn 4 arrives while queue is already at maxBehind (2).
  // It should be COALESCED into item 2, NOT grow the queue to 3!
  orchestrator.onMessage({ role: "user", content: "message-4", timestamp: 4 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  overview = orchestrator.statusOverview()[0]!;
  assert.equal(overview.backlog, 2, "backlog must remain capped at maxBehind");
  assert.equal(overview.backlogMessages, 3, "messages from coalesced turn 4 must be preserved");

  // Turn 5 arrives: also coalesced into item 2!
  orchestrator.onMessage({ role: "user", content: "message-5", timestamp: 5 });
  orchestrator.onTurnEnd();
  orchestrator.onTurnStart();

  overview = orchestrator.statusOverview()[0]!;
  assert.equal(overview.backlog, 2, "backlog must remain capped at maxBehind");
  assert.equal(overview.backlogMessages, 4, "messages from coalesced turn 5 must be preserved");

  // Allow turn 1 to complete: advisor pops item 1 (message-2)
  allowTurn1.resolve();
  await new Promise(r => setTimeout(r, 50));

  // Allow turn 2 to complete: advisor pops item 2 (which now contains message-3, 4, 5 combined!)
  allowTurn2.resolve();
  await new Promise(r => setTimeout(r, 50));

  allowTurn3.resolve();
  await orchestrator.drainForExit(1000);

  // Cumulative message counts across turns:
  // Turn 1 had 1 message (message-1)
  // Turn 2 had 2 messages (message-1, message-2)
  // Turn 3 had 5 messages (message-1, message-2, and message-3, 4, 5 coalesced together!)
  assert.deepEqual(reviewedBatchSizes, [1, 2, 5]);
});

test("flushes in-flight held batch to advisor when flushTimeoutMs expires", async t => {
  const reviewed = deferred();
  let receivedText = "";

  const { orchestrator } = await harness(t, async (text) => {
    receivedText = text;
    reviewed.resolve();
  }, {
    flushTimeoutMs: 150,
  });

  // Assistant emits a tool call message and turn_end fires
  orchestrator.onMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "long-job" } }],
    timestamp: 1,
  } as unknown as AgentMessage);
  orchestrator.onTurnEnd();

  // Before flushTimeoutMs (150ms), advisor has not been called yet.
  assert.equal(receivedText, "");

  // Wait for flushTimeoutMs to fire:
  await reviewed.promise;
  assert.match(receivedText, /long-job/);
  assert.match(receivedText, /in progress — more steps follow/);

  await orchestrator.drainForExit(1000);
});

