import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  AdvisorContextBudgetError, AdvisorContextWindow, DEFAULT_ADVISOR_CONTEXT_TOKENS,
  estimateContextMessageTokens, installAdvisorContextWindow,
} from "./context-window.ts";

const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<"openai-completions">;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content, stopReason, timestamp: 2, model: model.id, provider: model.provider, api: model.api,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const response = (text: string) => assistant([{ type: "text", text }]);
const call = (id: string) => assistant([{ type: "toolCall", id, name: "read_file", arguments: {} }], "toolUse");
const result = (id: string, text: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text }], isError: false, timestamp: 3 });
const body = (messages: AgentMessage[]) => JSON.stringify(messages);

test("the default is a bounded 32k memory that resets at an update boundary", () => {
  const window = new AdvisorContextWindow();
  assert.equal(window.requestedTokens, 32_000);
  const input = Array.from({ length: 25 }, (_, i) => [
    user(`observation-${i}: ${"x".repeat(25_000)}`), response(`review-${i}`),
  ]).flat();
  const currentStart = input.length - 2;
  const view = window.trim(input, 0, 0, currentStart);
  assert.doesNotMatch(body(view), /observation-0:/);
  assert.match(body(view), /observation-24:/);
  assert.ok(window.status.estimatedTokens <= DEFAULT_ADVISOR_CONTEXT_TOKENS);
  assert.equal(window.status.resets, 1);
  assert.deepEqual(view, input.slice(currentStart), "overflow drops the whole old prefix instead of sliding it");
});

test("eviction preserves complete tool-call/result groups and never mutates source messages", () => {
  const window = new AdvisorContextWindow(2048);
  const oldCall = call("old-call");
  const oldResult = result("old-call", "old result ".repeat(1500));
  const currentCall = call("current-call");
  const currentResult = result("current-call", "new result");
  const input = [user("old observation"), oldCall, oldResult, user("current observation"), currentCall, currentResult];
  const before = JSON.stringify(input);
  const view = window.trim(input, 0, 0, 3);
  assert.doesNotMatch(body(view), /old-call/);
  assert.ok(view.includes(currentCall));
  assert.ok(view.includes(currentResult));
  assert.equal(JSON.stringify(input), before);
});

test("large current observations and tool results are explicitly shortened without changing call identity", () => {
  const window = new AdvisorContextWindow(2048);
  const observation = user(`GOAL_START ${"u".repeat(16_000)} GOAL_END`);
  const invocation = call("large-read");
  const output = result("large-read", `OUTPUT_START ${"r".repeat(40_000)} OUTPUT_END`);
  const view = window.trim([observation, invocation, output]);
  assert.ok(view.includes(invocation), "assistant calls/signatures are untouched");
  assert.match(body(view), /GOAL_START/);
  assert.match(body(view), /GOAL_END/);
  assert.match(body(view), /OUTPUT_START/);
  assert.match(body(view), /OUTPUT_END/);
  assert.match(body(view), /Content omitted by the advisor context budget/);
  const keptResult = view.find(message => message.role === "toolResult");
  assert.equal(keptResult?.toolCallId, "large-read");
  assert.equal(keptResult?.isError, false);
  assert.ok(window.status.estimatedTokens <= 2048);
});

test("expired material cannot reappear during a later transform with more free space", () => {
  const window = new AdvisorContextWindow(2048);
  const old = user("OLD_SECRET_MARKER " + "x".repeat(4000));
  const priorReview = response("Earlier review");
  const latest = user("NEW " + "y".repeat(12_000));
  assert.doesNotMatch(body(window.trim([old, priorReview, latest], 0, 0, 2)), /OLD_SECRET_MARKER/);
  // The SDK loop can supply its original untrimmed array again after a tool call.
  const next = window.trim([old, priorReview, latest, user("A short newer observation")], 0, 0, 2);
  assert.doesNotMatch(body(next), /OLD_SECRET_MARKER/);
  assert.ok(window.status.estimatedTokens <= 2048);
});

test("expiry follows every alias when original and shortened tool histories alternate", () => {
  const window = new AdvisorContextWindow(2048);
  const original = [user("Earlier observation"), call("alias-call"), result("alias-call", "x".repeat(20_000))];
  const first = window.trim(original);
  assert.notEqual(first.at(-1), original.at(-1), "the result really was shortened");
  const latest = user("New observation " + "y".repeat(20_000));
  const second = window.trim([...first, latest]);
  assert.doesNotMatch(body(second), /alias-call/);
  assert.deepEqual(window.trim([...original, latest]), second, "the original result cannot outlive its expired call");
  assert.deepEqual(window.trim([...first, latest]), second, "neither can an older shortened view");
});

test("all aliases retain the newest shortening, even when more budget becomes available", () => {
  const window = new AdvisorContextWindow(4096);
  const original = user("x".repeat(30_000));
  const first = window.trim([original])[0]!;
  const second = window.trim([first], 2000)[0]!;
  assert.ok(body([second]).length < body([first]).length);
  assert.deepEqual(window.trim([original]), [second]);
  assert.deepEqual(window.trim([first]), [second]);
});

test("a context hook can expire a shortened exchange without poisoning retained Agent history", async () => {
  const original = [user("Earlier observation"), call("hook-call"), result("hook-call", "x".repeat(20_000))];
  const agent = new Agent({
    initialState: { model, messages: original, systemPrompt: "Review", tools: [] },
    streamFn: () => { throw new Error("This context-hook test does not make model requests"); },
    transformContext: async messages => [...messages, user("Hook observation " + "y".repeat(20_000))],
  });
  const memory = installAdvisorContextWindow(agent, 2048);
  try {
    const view = await agent.transformContext!(agent.state.messages);
    assert.doesNotMatch(body(view), /hook-call/);
    assert.doesNotThrow(() => memory.trimRetainedHistory());
    assert.doesNotMatch(body(agent.state.messages), /hook-call/);
  } finally { memory.dispose(); }
});

test("the input ceiling counts fixed instructions and leaves model headroom", () => {
  const window = new AdvisorContextWindow(32_000);
  const view = window.trim([user("x".repeat(20_000))], 500, 4096);
  assert.equal(window.status.limitTokens, 3072);
  assert.ok(window.status.estimatedTokens <= 3072);
  assert.ok(view.reduce((n, m) => n + estimateContextMessageTokens(m), 0) < 2572);
  assert.throws(() => window.trim([user("hello")], 30_000, 4096), AdvisorContextBudgetError);
});

test("an oversized required call fails safely instead of rewriting arguments or inventing tool results", () => {
  const window = new AdvisorContextWindow(2048);
  const invocation = assistant([{ type: "toolCall", id: "huge", name: "read_file", arguments: { data: "x".repeat(20_000) } }], "toolUse");
  const input = [user("current task"), invocation, result("huge", "actual result")];
  const before = JSON.stringify(input);
  assert.throws(() => window.trim(input), /cannot fit.*without breaking tool-call pairing/);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => new AdvisorContextWindow(2048).trim([result("missing", "orphan")]), /orphan tool result/);
});

test("failed partial tool calls do not poison the next observation", () => {
  for (const stopReason of ["aborted", "error"] as const) {
    const window = new AdvisorContextWindow(2048);
    const failed = assistant([{ type: "toolCall", id: "partial-call", name: "read_file", arguments: {} }], stopReason);
    const view = window.trim([user("older observation"), failed, user("current observation")]);
    assert.doesNotMatch(body(view), /partial-call/);
    assert.match(body(view), /current observation/);
  }
});

test("a real Agent applies the bound again after a large investigative tool result", async () => {
  let requests = 0;
  const requestsSeen: string[] = [];
  let existingHookCalls = 0;
  const agent = new Agent({
    initialState: {
      model, systemPrompt: "Review the current observation.",
      messages: [user("OLD_CONTEXT " + "z".repeat(20_000))],
      tools: [{ name: "read_file", label: "Read fixture", description: "Read test content", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "READ_START " + "x".repeat(40_000) + " READ_END" }], details: undefined }),
      }],
    },
    transformContext: async messages => { existingHookCalls++; return structuredClone(messages); },
    streamFn: (_model, context) => {
      requests++;
      requestsSeen.push(JSON.stringify(context.messages));
      const message = requests === 1 ? call("live-read") : assistant([{ type: "text", text: "Reviewed." }]);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    },
  });
  const memory = installAdvisorContextWindow(agent, 2048);
  await agent.prompt("Inspect this fixture now.");
  assert.equal(requests, 2);
  assert.equal(existingHookCalls, 2, "the SDK's existing context hook is preserved");
  assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop", "request checks cannot hide behind a caught provider error");
  for (const view of requestsSeen) assert.doesNotMatch(view, /OLD_CONTEXT/);
  assert.match(requestsSeen[1]!, /Content omitted by the advisor context budget/);
  assert.match(requestsSeen[1]!, /READ_END/);
  assert.ok(requestsSeen[1]!.length < 9000);
  memory.trimRetainedHistory();
  assert.doesNotMatch(body(agent.state.messages), /OLD_CONTEXT/);
  assert.ok(body(agent.state.messages).length < 9000);
  assert.ok(memory.window.status.estimatedTokens <= 2048);
});

test("an observed abort remains an interruption even if a provider returns a normal stop", async () => {
  const agent: Agent = new Agent({
    initialState: { model, systemPrompt: "Review observations.", tools: [] },
    streamFn: () => {
      agent.abort(); // Deliberately model a provider that ignores cancellation.
      const message = assistant([{ type: "text", text: "Looks complete, but was interrupted." }]);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
  const memory = installAdvisorContextWindow(agent, 4096);
  await agent.prompt("Observe this step.");
  assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
  assert.equal(memory.interrupted, true, "the orchestrator must not release deferred advice for this run");
  memory.trimRetainedHistory();
  assert.equal(memory.interrupted, true);
  memory.dispose();
});

for (const toolExecution of ["parallel", "sequential"] as const) {
  test(`a real Agent recovers after interruption leaves an incomplete ${toolExecution} tool group`, async () => {
    const requestsSeen: string[] = [];
    const agent = new Agent({
      initialState: {
        model, systemPrompt: "Review observations.",
        messages: [user("Earlier observation"), call("earlier-complete"), result("earlier-complete", "An earlier result")],
        tools: [{ name: "read_file", label: "Read fixture", description: "Read fixture", parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "Actual first result" }], details: undefined }),
        }],
      },
      toolExecution,
      streamFn: (_model, context) => {
        requestsSeen.push(JSON.stringify(context.messages));
        const message = requestsSeen.length === 1
          ? assistant([
            { type: "toolCall", id: "cancel-first", name: "read_file", arguments: {} },
            { type: "toolCall", id: "cancel-second", name: "read_file", arguments: {} },
          ], "toolUse")
          : assistant([{ type: "text", text: "New observation reviewed." }]);
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
        return stream;
      },
    });
    const memory = installAdvisorContextWindow(agent, 4096);
    const detach = agent.subscribe(event => {
      if (event.type === "tool_execution_start" && event.toolCallId === "cancel-first") agent.abort();
    });
    await agent.prompt("An observation that will be interrupted.");
    const newResults = agent.state.messages.filter(message => message.role === "toolResult" && message.toolCallId.startsWith("cancel-"));
    assert.equal(newResults.length, 1, "the real SDK left only one result for two calls");
    assert.notEqual((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
    assert.doesNotThrow(() => memory.trimRetainedHistory());
    assert.equal(memory.interrupted, true);
    assert.doesNotMatch(body(agent.state.messages), /cancel-first|cancel-second/);
    assert.match(body(agent.state.messages), /earlier-complete/);

    await agent.prompt("A genuinely new observation.");
    assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
    assert.equal(memory.interrupted, false);
    assert.equal(requestsSeen.length, 2, "the interrupted run did not make another model request");
    assert.doesNotMatch(requestsSeen[1]!, /cancel-first|cancel-second/);
    assert.match(requestsSeen[1]!, /genuinely new observation/);
    memory.trimRetainedHistory();
    memory.dispose();
    detach();
  });
}
