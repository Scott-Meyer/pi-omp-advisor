import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { AdvisorUsageLedger, formatAdvisorUsage } from "./usage.ts";

const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: true, input: ["text"], contextWindow: 100_000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } } as Model<"openai-completions">;
function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: 1,
    content: [{ type: "text", text: "Reviewed" }], stopReason: "stop",
    usage: { input: 100, output: 30, reasoning: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 190, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } },
    ...overrides,
  };
}
function stream(message: AssistantMessage) {
  const result = createAssistantMessageEventStream();
  result.push({ type: "start", partial: message });
  result.push({ type: "text_delta", contentIndex: 0, delta: "", partial: message });
  if (message.stopReason === "error" || message.stopReason === "aborted") result.push({ type: "error", reason: message.stopReason, error: message });
  else result.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
  result.end();
  return result;
}

test("real Agent tool loops accumulate once per finalized response even after history loss", async () => {
  let requests = 0;
  let executed = 0;
  const events: AgentEvent[] = [];
  const agent = new Agent({
    initialState: { model, tools: [{ name: "read", label: "Read", description: "Read", parameters: Type.Object({}), execute: async () => { executed++; return { content: [{ type: "text", text: "evidence" }], details: {} }; } }] },
    streamFn: () => {
      requests++;
      return stream(response(requests <= 2 ? { content: [{ type: "toolCall", name: "read", id: `read-${requests}`, arguments: {} }], stopReason: "toolUse" } : {}));
    },
  });
  const ledger = new AdvisorUsageLedger();
  const connection = ledger.connect(agent);
  const detach = agent.subscribe(event => { events.push(event); if (event.type === "turn_end") agent.state.messages = []; });
  await agent.prompt("Review the evidence");
  assert.equal(executed, 2);
  assert.equal(agent.state.messages.length, 0);
  assert.ok(events.some(event => event.type === "message_update"));
  const status = ledger.snapshot();
  assert.deepEqual(status, {
    modelRequests: 3, modelResponses: 3, toolRequests: 2, toolRequestsByName: { read: 2 },
    tokens: { input: 300, output: 90, cacheRead: 150, cacheWrite: 30 },
    responsesWithUsage: 3, responsesWithCost: 3, estimatedCostUsd: 0.99,
  });
  assert.equal(connection.lastResponse?.stopReason, "stop");
  assert.equal(connection.completedResponses, 3);
  assert.deepEqual(ledger.snapshot(), status);
  status.tokens.input = 99;
  status.toolRequestsByName.read = 99;
  assert.equal(ledger.snapshot().tokens.input, 300, "snapshots cannot mutate the ledger");
  assert.equal(ledger.snapshot().toolRequestsByName.read, 2);
  const frozen = ledger.snapshot();
  connection.dispose();
  detach();
  await agent.prompt("Old agent after detachment");
  assert.deepEqual(ledger.snapshot(), frozen, "retired agents cannot add usage");
});

test("reported failed/aborted usage counts; synthetic failures and missing pricing stay visibly partial", async () => {
  const ledger = new AdvisorUsageLedger();
  let nextResponse = () => stream(response({ stopReason: "aborted" }));
  const agent = new Agent({ initialState: { model }, streamFn: () => nextResponse() });
  const connection = ledger.connect(agent);
  await agent.prompt("Interrupted paid response");
  nextResponse = () => { throw new Error("provider failed before reporting usage"); };
  await agent.prompt("Provider error");
  nextResponse = () => stream(response({ usage: { ...response().usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }));
  await agent.prompt("Response without configured pricing");
  const status = ledger.snapshot();
  assert.equal(status.modelRequests, 3);
  assert.equal(status.modelResponses, 3);
  assert.equal(status.responsesWithUsage, 2);
  assert.equal(status.responsesWithCost, 1);
  assert.equal(status.tokens.output, 60);
  assert.equal(status.estimatedCostUsd, 0.33);
  const text = formatAdvisorUsage(status);
  assert.match(text, /partial 2\/3 responses/);
  assert.match(text, /partial 1\/3 responses/);
  assert.match(text, /includes reported reasoning/);
  assert.match(text, /not an invoice/);
  assert.match(text, /provider-internal retries\/unreported usage not included/);
  connection.dispose();
});

test("missing usage is not silently reported as free, including on hosts with minimal messages", () => {
  let listener!: (event: AgentEvent) => void;
  const ledger = new AdvisorUsageLedger();
  ledger.connect({ subscribe(callback) { listener = callback; return () => {}; } });
  listener({ type: "turn_start" });
  listener({ type: "message_end", message: response({ usage: undefined as unknown as AssistantMessage["usage"] }) });
  const status = ledger.snapshot();
  assert.equal(status.modelResponses, 1);
  assert.equal(status.responsesWithUsage, 0);
  assert.equal(status.responsesWithCost, 0);
  assert.match(formatAdvisorUsage(status), /tokens unavailable/);
  assert.match(formatAdvisorUsage(status), /cost estimate unavailable/);
  assert.doesNotMatch(formatAdvisorUsage(status), /\$0/);
});
