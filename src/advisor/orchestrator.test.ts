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
async function harness(t: TestContext, review: Review, options?: { stop?: PrimaryStopAccess; contextTokens?: number; includePrimaryThinking?: boolean; syncBacklog?: unknown; maxBehind?: number; flushTimeoutMs?: number; flushOnSettled?: boolean; primary?: { isStreaming(): boolean; isAborting(): boolean; isAutoResumeSuppressed(): boolean; hasQueuedWork?(): boolean } }) {
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
    hasQueuedWork: () => options?.primary?.hasQueuedWork?.() ?? false,
    setStatus: () => {},
  };
  let sessionCount = 0;
  const advisorStates: Array<{
    messages: AgentMessage[];
    isStreaming: boolean;
    streamingMessage?: AgentMessage | null;
    streamMessage?: AgentMessage | null;
  }> = [];
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
    advisorStates.push(state);
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
    `maxBehind: ${options?.maxBehind ?? 1}`,
    ...(options?.flushTimeoutMs !== undefined ? [`flushTimeoutMs: ${options.flushTimeoutMs}`] : []),
    ...(options?.flushOnSettled !== undefined ? [`flushOnSettled: ${options.flushOnSettled}`] : []),
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
  return { orchestrator, inbox, sent, whenPreserved: preserved.promise, sessionCount: () => sessionCount, advisorStates };
}

function update(orchestrator: AdvisorOrchestrator, final: boolean) {
  orchestrator.onMessage({ role: "user", content: "A new observed step", timestamp: Date.now() });
  orchestrator.onTurnEnd();
  if (final) orchestrator.onAgentSettled();
  else orchestrator.onTurnStart();
}

test("an OMP child without a supported context hook is disposed instead of partially published", async t => {
  t.mock.method(console, "error", () => {});
  const cwd = await mkdtemp(join(tmpdir(), "advisor-unsupported-context-"));
  const agentDir = join(cwd, "agent-config");
  await mkdir(agentDir);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "WATCHDOG.yml"), "main: true\n");
  const discovered = await discoverAdvisorConfigs(cwd, agentDir);
  let disposed = 0;
  const createSession: typeof createAgentSession = async () => ({
    session: {
      agent: {
        state: { messages: [], isStreaming: false, systemPrompt: "", tools: [], model: { contextWindow: 128_000 } },
        subscribe: () => () => {},
        abort: () => {},
        waitForIdle: async () => {},
        prompt: async () => {},
      },
      setAdvisorEnabled: () => {},
      abort: async () => {},
      dispose: () => { disposed++; },
    },
  }) as unknown as Awaited<ReturnType<typeof createAgentSession>>;
  const host: OrchestratorHost = {
    sendCustom: () => {}, preserveAdvice: () => {}, pendingAdvice: () => [],
    reviseAdvice: () => false, withdrawAdvice: () => false,
    currentTool: () => ({ status: "idle", activeCount: 0 }),
    requestStop: () => ({ requested: false, status: "disabled", message: "No stop grant" }),
    isStreaming: () => false, isAborting: () => false, isAutoResumeSuppressed: () => false,
    hasQueuedWork: () => false, setStatus: () => {},
  };
  const orchestrator = new AdvisorOrchestrator(host, createSession);
  await orchestrator.start(
    discovered,
    { cwd, models: {}, modelRegistry: {} } as unknown as ExtensionContext,
    {},
    agentDir,
  );
  assert.equal(disposed, 1);
  assert.deepEqual(orchestrator.advisorNames, []);
  await orchestrator.disposeAll();
});

test("real review tools revise/withdraw deferred notes before review releases them", async t => {
  let firstId = "";
  const reviewing = deferred();
  const finishReview = deferred();
  const { orchestrator, inbox } = await harness(t, async (_text, call) => {
    firstId = (await call("advise", { note: "Check tag policy", severity: "concern" })).adviceId;
    const pending = await call("pending_advice");
    assert.deepEqual(pending.pending.map((note: any) => note.adviceId), [firstId]);
    assert.equal((await call("revise_advice", { adviceId: firstId, note: "Check tag rule type" })).changed, true);
    reviewing.resolve();
    await finishReview.promise;
  });
  update(orchestrator, true);
  await reviewing.promise;
  assert.equal(inbox.items.length, 0, "still held while review is running");
  finishReview.resolve();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.deepEqual(inbox.items.map(note => note.note), ["Check tag rule type"]);
  assert.equal(inbox.items[0]!.adviceId, firstId);
});

test("real review tools can withdraw deferred notes before review releases them", async t => {
  const reviewing = deferred();
  const finishReview = deferred();
  const { orchestrator, inbox } = await harness(t, async (_text, call) => {
    const note = await call("advise", { note: "Login pending", severity: "concern" });
    assert.equal((await call("withdraw_advice", { adviceId: note.adviceId })).changed, true);
    reviewing.resolve();
    await finishReview.promise;
  });
  update(orchestrator, true);
  await reviewing.promise;
  finishReview.resolve();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.deepEqual(inbox.items, []);
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

test("pausing during review does not release notes even when an aborted prompt resolves", async t => {
  let turn = 0;
  const reviewing = deferred();
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call, signal) => {
    turn++;
    if (turn === 1) {
      await call("advise", { note: "Needs a second look", severity: "concern" });
      reviewing.resolve();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });
  update(orchestrator, true);
  await reviewing.promise;
  await orchestrator.setPaused(true);
  assert.deepEqual(inbox.items, []);
  assert.deepEqual(sent, []);
  await orchestrator.setPaused(false);
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.deepEqual(inbox.items, []);
});

test("a provider error that resolves normally does not count as a completed review", async t => {
  t.mock.method(console, "error", () => {});
  const recovered = deferred();
  let turn = 0;
  const { orchestrator, inbox } = await harness(t, async (_text, call) => {
    turn++;
    if (turn === 1) {
      await call("advise", { note: "Check before shipping", severity: "concern" });
      return "error";
    } else if (turn === 2) return "error";
    else {
      const pending = await call("pending_advice");
      assert.equal(pending.pending.length, 0, "failed review notes were discarded");
      recovered.resolve();
    }
  }, { includePrimaryThinking: true });
  update(orchestrator, true);
  await orchestrator.drainForExit(1000);
  assert.equal(turn, 2, "existing thinking-stripped retry was exercised");
  assert.equal(inbox.items.length, 0);
  update(orchestrator, true);
  await recovered.promise;
  assert.equal(turn, 3);
  assert.equal(inbox.items.length, 0);
});

for (const action of ["pause/resume", "reset", "dispose"] as const) {
  test(`${action} waits for the directly prompted Agent before proceeding`, { timeout: 5000 }, async t => {
    let turn = 0;
    const reviewingFinal = deferred();
    const aborted = deferred();
    const finishCleanup = deferred();
    t.after(() => finishCleanup.resolve());
    const { orchestrator, inbox, sent, sessionCount } = await harness(t, async (_text, call, signal) => {
      turn++;
      if (turn === 1) {
        await call("advise", { note: "Check this assumption", severity: "concern" });
        reviewingFinal.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        aborted.resolve();
        await finishCleanup.promise;
      }
    });
    update(orchestrator, true);
    await reviewingFinal.promise;

    const transition = action === "reset"
      ? orchestrator.resetRuntimesOnly()
      : action === "dispose"
        ? orchestrator.disposeAll()
        : Promise.all([orchestrator.setPaused(true), orchestrator.setPaused(false)]);
    let transitioned = false;
    const completed = transition.then(() => { transitioned = true; });
    await aborted.promise;
    assert.equal(transitioned, false, "Agent cancellation cleanup is still in flight");
    assert.equal(sessionCount(), 1, "a transition cannot build or leak a replacement session early");
    assert.equal(inbox.items.length, 0);
    assert.equal(sent.length, 0);
    finishCleanup.resolve();
    await completed;
    assert.equal(inbox.items.length, 0, "the cancelled final review cannot flush after the transition");
    if (action !== "dispose") {
      update(orchestrator, true);
      assert.equal(await orchestrator.drainForExit(1000), true);
      assert.equal(inbox.items.length, 0);
    }
    assert.equal(sessionCount(), action === "reset" ? 2 : 1);
  });
}

test("dispose racing a reset cannot create an orphan replacement runtime", { timeout: 5000 }, async t => {
  const reviewing = deferred();
  const aborted = deferred();
  const finishCleanup = deferred();
  t.after(() => finishCleanup.resolve());
  const { orchestrator, sessionCount } = await harness(t, async (_text, _call, signal) => {
    reviewing.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    aborted.resolve();
    await finishCleanup.promise;
  });
  update(orchestrator, true);
  await reviewing.promise;
  const reset = orchestrator.resetRuntimesOnly();
  await aborted.promise;
  const dispose = orchestrator.disposeAll();
  finishCleanup.resolve();
  await Promise.all([reset, dispose]);
  assert.equal(sessionCount(), 1, "reset observed disposal before constructing a replacement");
  assert.deepEqual(orchestrator.statusOverview(), []);
});

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

test("tool lifecycle never wakes an advisor, while a scheduled wake gets live stop metadata", async t => {
  const activity = { targetId: "execution-1", toolCallId: "primary-sleep-1", toolName: "bash", summary: "sleep 180", startedAt: Date.now() };
  const calls: string[] = [];
  let reviews = 0;
  const { orchestrator } = await harness(t, async (text, call) => {
    reviews++;
    assert.match(text, /Current primary tool state/);
    assert.match(text, /primary-sleep-1/);
    assert.match(text, /execution-1/);
    const result = await call("request_stop", { targetId: activity.targetId, reason: "Explicit user-requested sleep cancellation test" });
    assert.equal(result.requested, true);
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

  // The host controller may observe any number of starts; none is an advisor
  // scheduler event. Only the ordinary turn boundary below causes a review.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reviews, 0);
  orchestrator.onMessage({ role: "user", content: "Observe this call and stop the diagnostic sleep", timestamp: Date.now() });
  orchestrator.onTurnEnd();
  orchestrator.onAgentSettled();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(reviews, 1);
  assert.deepEqual(calls, [activity.targetId]);
});

for (const reason of ["length", "deferred"] as const) {
  test(`${reason} responses retain notes until a genuinely completed review`, async t => {
    t.mock.method(console, "error", () => {});
    let turn = 0;
    let id = "";
    const { orchestrator, inbox, whenPreserved } = await harness(t, async (_text, call) => {
      turn++;
      if (turn === 1) {
        await call("advise", { note: "Reconsider this", severity: "concern" });
        return reason;
      } else if (turn === 2) return "error";
      else {
        const result = await call("advise", { note: "Reconsider this", severity: "concern" });
        id = result.adviceId;
      }
    }, { includePrimaryThinking: true });
    update(orchestrator, true);
    await orchestrator.drainForExit(1000);
    assert.equal(turn, 2);
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
    if (turn <= 3) {
      const text = `Updated observation ${turn}`;
      assert.equal((await call("revise_advice", { adviceId: id, note: text })).changed, true);
      assert.equal((await call("advise", { note: text.toUpperCase(), severity: "concern" })).suppressed, true);
      assert.equal((await call("advise", { note: `Independent observation ${turn}`, severity: "nit" })).suppressed, false);
      return;
    }
    if (turn === 4) {
      const temp = await call("advise", { note: "Temporary post-rebuild note", severity: "concern" });
      assert.equal((await call("withdraw_advice", { adviceId: temp.adviceId })).changed, true);
      return;
    }
    if (turn === 5) {
      const reRaised = await call("advise", { note: "Temporary post-rebuild note", severity: "concern" });
      assert.equal(reRaised.suppressed, false, "withdrawn note post-rebuild must not be permanently blocked");
      return;
    }
  });
  for (let step = 1; step <= 5; step++) {
    if (step === 3) await orchestrator.resetRuntimesOnly();
    update(orchestrator, true);
    assert.equal(await orchestrator.drainForExit(1000), true);
  }
  assert.equal(sessionCount(), 2);
  assert.deepEqual(inbox.items.map(note => note.note), ["Updated observation 3", "Independent observation 2", "Independent observation 3", "Temporary post-rebuild note"]);
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

test("three continuing primary turns produce one advisor wake with one combined delta", async t => {
  const reviews: string[] = [];
  const { orchestrator, advisorStates } = await harness(t, async text => { reviews.push(text); }, { maxBehind: 3 });
  for (let turn = 1; turn <= 3; turn++) {
    orchestrator.onMessage({ role: "user", content: `batched-turn-${turn}`, timestamp: turn });
    orchestrator.onTurnEnd();
    orchestrator.onTurnStart();
    if (turn < 3) assert.equal(reviews.length, 0);
  }
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(reviews.length, 1);
  for (let turn = 1; turn <= 3; turn++) assert.match(reviews[0]!, new RegExp(`batched-turn-${turn}`));
  const status = orchestrator.statusOverview()[0]!;
  assert.equal(status.wakes, 1);
  assert.equal(status.modelRequests, 1);

  // The stream viewer reads the advisor's own session: its context contains the
  // observed turns and the review it produced.
  const snapshots = orchestrator.transcriptSnapshot();
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]!.name, "reviewer");
  assert.equal(snapshots[0]!.streaming, false);
  const transcript = snapshots[0]!.messages.map(m => JSON.stringify(m)).join("\n");
  assert.match(transcript, /batched-turn-3/);
  assert.equal(orchestrator.transcriptSnapshot("reviewer").length, 1, "name filter selects the advisor");
  assert.equal(orchestrator.transcriptSnapshot("nope").length, 0, "unknown names select nothing");

  // OMP names the live field `streamMessage`; Pi uses `streamingMessage`.
  const state = advisorStates.at(-1)!;
  state.isStreaming = true;
  state.streamMessage = { role: "assistant", content: [{ type: "text", text: "OMP live review" }] } as AgentMessage;
  const live = orchestrator.transcriptSnapshot()[0]!;
  assert.equal(live.streaming, true);
  assert.match(live.messages.map(message => JSON.stringify(message)).join("\n"), /OMP live review/);
});

test("settlement with flushOnSettled off does not wake short runs before the shared turn threshold", async t => {
  const reviews: string[] = [];
  const { orchestrator } = await harness(t, async text => { reviews.push(text); }, { maxBehind: 3, flushOnSettled: false });
  for (let run = 1; run <= 3; run++) {
    orchestrator.onMessage({ role: "user", content: `short-run-${run}`, timestamp: run });
    orchestrator.onTurnEnd();
    orchestrator.onAgentSettled();
    if (run < 3) assert.equal(reviews.length, 0, "settlement preserves the economical cross-run batch");
  }
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(reviews.length, 1);
  for (let run = 1; run <= 3; run++) assert.match(reviews[0]!, new RegExp(`short-run-${run}`));
  assert.doesNotMatch(reviews[0]!, /in progress — more steps follow/);
});

test("settlement delivers a short completed run immediately by default", async t => {
  const reviews: string[] = [];
  const { orchestrator } = await harness(t, async text => { reviews.push(text); }, { maxBehind: 3 });
  orchestrator.onMessage({ role: "user", content: "short-run-1", timestamp: 1 });
  orchestrator.onTurnEnd();
  orchestrator.onAgentSettled();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(reviews.length, 1, "settlement flushes below the turn threshold without opting in");
  assert.match(reviews[0]!, /short-run-1/);
  const status = orchestrator.statusOverview()[0]!;
  assert.equal(status.flushOnSettled, true);
  assert.equal(status.pendingTurns, 0);
});

test("flushOnSettled does not flush an empty queue on settlement", async t => {
  const reviews: string[] = [];
  const { orchestrator } = await harness(t, async text => { reviews.push(text); }, { maxBehind: 3, flushOnSettled: true });
  orchestrator.onAgentSettled();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(reviews.length, 0, "nothing observed means nothing to deliver");
});


test("waitForCatchup pauses when queued turns reach pauseAt and resumes when the merged successor starts", async t => {
  const allowTurn1 = deferred();
  const allowCatchup = deferred();
  let turnCount = 0;

  const { orchestrator } = await harness(t, async () => {
    turnCount++;
    if (turnCount === 1) await allowTurn1.promise;
    else if (turnCount === 2) await allowCatchup.promise;
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

  // Completing the active review moves the single coalesced successor (turns
  // 2-4) into the active slot atomically. No queued turns remain, so the
  // primary may resume while that catch-up review runs.
  allowTurn1.resolve();
  await p;
  assert.equal(catchupReturned, true, "the merged successor left the waiting queue");
  assert.equal(orchestrator.statusOverview()[0]!.backlog, 0);

  allowCatchup.resolve();
  await orchestrator.drainForExit(1000);
});

test("batches turns while keeping at most one merged successor behind a busy advisor", async t => {
  const allowFirst = deferred();
  const allowSecond = deferred();
  let reviewCount = 0;
  const reviewedBatchSizes: number[] = [];

  const { orchestrator } = await harness(t, async text => {
    reviewCount++;
    reviewedBatchSizes.push((text.match(/message-\d+/g) || []).length);
    if (reviewCount === 1) await allowFirst.promise;
    else if (reviewCount === 2) await allowSecond.promise;
  }, { maxBehind: 2 });

  const primaryTurn = (number: number) => {
    orchestrator.onMessage({ role: "user", content: `message-${number}`, timestamp: number });
    orchestrator.onTurnEnd();
    orchestrator.onTurnStart();
  };

  primaryTurn(1);
  assert.equal(reviewCount, 0, "one turn is below the two-turn wake threshold");
  primaryTurn(2);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reviewCount, 1, "turns 1-2 produce one active review");

  primaryTurn(3);
  primaryTurn(4); // one successor containing turns 3-4
  primaryTurn(5);
  primaryTurn(6); // merged into that same successor

  const overview = orchestrator.statusOverview()[0]!;
  assert.equal(overview.backlog, 4, "four primary turns are waiting behind the active review");
  assert.equal(overview.backlogMessages, 4);
  assert.equal(overview.pendingTurns, 0);
  assert.equal(overview.wakes, 3, "two threshold flushes merged into one successor");

  allowFirst.resolve();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reviewCount, 2);
  allowSecond.resolve();
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.deepEqual(reviewedBatchSizes, [2, 6], "second provider view contains the prior context plus one four-turn delta");
  assert.equal(orchestrator.statusOverview()[0]!.modelRequests, 2);
});

test("flushes the oldest partial turn when its unchanged deadline expires", async t => {
  const reviewed = deferred();
  let receivedText = "";

  const { orchestrator } = await harness(t, async (text) => {
    receivedText = text;
    reviewed.resolve();
  }, {
    maxBehind: 3,
    flushTimeoutMs: 150,
    primary: {
      isStreaming: () => true,
      isAborting: () => false,
      isAutoResumeSuppressed: () => false,
    },
  });

  // Assistant emits a tool call as an ordinary primary turn.
  orchestrator.onMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "long-job" } }],
    timestamp: 1,
  } as unknown as AgentMessage);

  // No turn_end yet: the primary tool represented by that finalized assistant
  // message may still be running. The deadline is based on message arrival.
  // Before flushTimeoutMs (150ms), advisor has not been called yet.
  assert.equal(receivedText, "");

  // Wait for flushTimeoutMs to fire:
  await reviewed.promise;
  assert.match(receivedText, /long-job/);
  assert.match(receivedText, /in progress — more steps follow/);

  // The eventual primary boundary cannot dispatch the same message again.
  orchestrator.onTurnEnd();
  orchestrator.onAgentSettled();
  await orchestrator.drainForExit(1000);
});

test("healthy active-run concern steers live into streaming primary", async t => {
  let id = "";
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    const result = await call("advise", { note: "Wrong test target", severity: "concern" });
    id = result.adviceId;
  }, { primary: {
    isStreaming: () => true,
    isAborting: () => false,
    isAutoResumeSuppressed: () => false,
  } });
  update(orchestrator, false);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(inbox.items.length, 0, "active-run concern must not go to inbox");
  assert.equal(sent.length, 1, "active-run concern must steer into live primary");
  assert.equal(sent[0]!.options.deliverAs, "steer");
  assert.equal(sent[0]!.options.triggerTurn, true);
  assert.match(sent[0]!.content, /Wrong test target/);
  assert.ok(id);
});

test("healthy active-run nit delivers as aside to streaming primary", async t => {
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    await call("advise", { note: "Style nit", severity: "nit" });
  }, { primary: {
    isStreaming: () => true,
    isAborting: () => false,
    isAutoResumeSuppressed: () => false,
  } });
  update(orchestrator, false);
  assert.equal(await orchestrator.drainForExit(1000), true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(inbox.items.length, 0, "active-run nit must not go to inbox");
  assert.equal(sent.length, 1, "active-run nit must deliver as aside");
  assert.equal(sent[0]!.options.deliverAs, "steer");
  assert.equal(sent[0]!.options.triggerTurn, undefined);
  assert.match(sent[0]!.content, /Style nit/);
});

test("settled primary review preserves concern to inbox when no queued work", async t => {
  let id = "";
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    const result = await call("advise", { note: "Late concern", severity: "concern" });
    id = result.adviceId;
  }, { primary: {
    isStreaming: () => false,
    isAborting: () => false,
    isAutoResumeSuppressed: () => false,
    hasQueuedWork: () => false,
  } });
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(sent.length, 0, "settled concern must not steer");
  assert.equal(inbox.items.length, 1, "settled concern must preserve to inbox");
  assert.equal(inbox.items[0]!.adviceId, id);
  assert.equal(inbox.items[0]!.note, "Late concern");
});

test("settled primary review steers concern when queued work exists", async t => {
  let id = "";
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    const result = await call("advise", { note: "Work in queue concern", severity: "concern" });
    id = result.adviceId;
  }, { primary: {
    isStreaming: () => false,
    isAborting: () => false,
    isAutoResumeSuppressed: () => false,
    hasQueuedWork: () => true,
  } });
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(inbox.items.length, 0, "must not preserve when queued work exists");
  assert.equal(sent.length, 1, "must steer when queued work exists");
  assert.equal(sent[0]!.options.deliverAs, "steer");
  assert.equal(sent[0]!.options.triggerTurn, true);
  assert.match(sent[0]!.content, /Work in queue concern/);
  assert.ok(id);
});

test("settled primary review steers blocker even when idle and no queued work", async t => {
  let id = "";
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    const result = await call("advise", { note: "Critical handoff failure", severity: "blocker" });
    id = result.adviceId;
  }, { primary: {
    isStreaming: () => false,
    isAborting: () => false,
    isAutoResumeSuppressed: () => false,
    hasQueuedWork: () => false,
  } });
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(inbox.items.length, 0, "blocker must not preserve to inbox");
  assert.equal(sent.length, 1, "blocker must steer into primary");
  assert.equal(sent[0]!.options.deliverAs, "steer");
  assert.equal(sent[0]!.options.triggerTurn, true);
  assert.match(sent[0]!.content, /Critical handoff failure/);
  assert.ok(id);
});

test("settled primary review preserves nit to inbox", async t => {
  let id = "";
  const { orchestrator, inbox, sent } = await harness(t, async (_text, call) => {
    const result = await call("advise", { note: "Late nit", severity: "nit" });
    id = result.adviceId;
  }, { primary: {
    isStreaming: () => false,
    isAborting: () => false,
    isAutoResumeSuppressed: () => false,
    hasQueuedWork: () => false,
  } });
  update(orchestrator, true);
  assert.equal(await orchestrator.drainForExit(1000), true);
  assert.equal(sent.length, 0, "settled nit must not steer");
  assert.equal(inbox.items.length, 1, "settled nit must preserve to inbox");
  assert.equal(inbox.items[0]!.adviceId, id);
  assert.equal(inbox.items[0]!.note, "Late nit");
});

