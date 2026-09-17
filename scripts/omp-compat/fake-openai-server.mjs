import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const port = Number(process.env.PORT || 43127);
const logPath = process.env.REQUEST_LOG;
const scenario = process.env.SCENARIO || "direct-advice";
const readPath = process.env.READ_PATH;
let requestNumber = 0;
let primaryRequestNumber = 0;
let advisorRequestNumber = 0;

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function chunk(id, delta, finish_reason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "compat-model",
    choices: [{ index: 0, delta, finish_reason }],
  };
}

function validateToolPairing(messages) {
  let pending;
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending?.has(message.tool_call_id)) return `unmatched or duplicate tool result ${message.tool_call_id}`;
      pending.delete(message.tool_call_id);
      continue;
    }
    if (pending?.size) return `tool calls missing results before ${message.role}: ${[...pending].join(", ")}`;
    pending = undefined;
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const ids = message.tool_calls.map(call => call?.id).filter(Boolean);
      if (ids.length !== message.tool_calls.length) return "assistant tool call missing an id";
      if (new Set(ids).size !== ids.length) return "duplicate assistant tool-call ids";
      pending = new Set(ids);
    }
  }
  return pending?.size ? `tool calls missing results at end of request: ${[...pending].join(", ")}` : undefined;
}

function sendSse(res, events) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "compat-model", object: "model", owned_by: "compat" }] }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `No fixture route for ${req.method} ${req.url}` } }));
    return;
  }

  let raw = "";
  for await (const data of req) raw += data;
  const body = JSON.parse(raw);
  requestNumber += 1;
  const messages = body.messages || [];
  const toolNames = (body.tools || []).map(tool => tool?.function?.name).filter(Boolean);
  const hasAdvise = toolNames.includes("advise");
  const last = messages.at(-1);
  const contentText = message => typeof message?.content === "string"
    ? message.content
    : JSON.stringify(message?.content ?? "");
  const calledTools = messages.flatMap(message =>
    (message.tool_calls || []).map(call => call?.function?.name).filter(Boolean));
  const lastUserIndex = messages.findLastIndex(message => message.role === "user");
  const currentCalledTools = messages.slice(lastUserIndex + 1).flatMap(message =>
    (message.tool_calls || []).map(call => call?.function?.name).filter(Boolean));
  const allText = messages.map(contentText).join("\n");
  const pairingError = validateToolPairing(messages);
  if (pairingError) {
    log({ requestNumber, scenario, event: "invalid-tool-pairing", pairingError, roles: messages.map(message => message.role) });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: pairingError } }));
    return;
  }
  log({
    requestNumber,
    scenario,
    path: req.url,
    model: body.model,
    stream: body.stream,
    toolNames,
    toolDescriptorChars: JSON.stringify(body.tools || []).length,
    roles: messages.map(message => message.role),
    contentChars: messages.map(message => contentText(message).length),
    totalContentChars: allText.length,
    hasWindowNotice: allText.includes("This is a bounded recent context window."),
    calledTools,
    currentCalledTools,
    lastRole: last?.role,
    lastToolCallId: last?.tool_call_id,
    lastText: typeof last?.content === "string" ? last.content.slice(0, 240) : undefined,
    systemPreview: contentText(messages.find(message => message.role === "system")).slice(0, 240),
    containsFirstAdvice: allText.includes("OMP compatibility sentinel: the external pi-omp-advisor"),
    advisorRequest: hasAdvise,
  });

  const id = `chatcmpl-compat-${requestNumber}`;
  if (!hasAdvise) primaryRequestNumber += 1;
  else advisorRequestNumber += 1;

  if (!hasAdvise && scenario === "empty-stop-retry" && primaryRequestNumber === 1) {
    sendSse(res, [chunk(id, { role: "assistant", content: "" }), chunk(id, {}, "stop")]);
    return;
  }

  if (!hasAdvise && scenario === "primary-abort-blocker") {
    let sent = false;
    const timer = setTimeout(() => {
      if (res.destroyed) return;
      sent = true;
      sendSse(res, [chunk(id, { role: "assistant", content: "Unexpected late primary response." }), chunk(id, {}, "stop")]);
    }, Number(process.env.PRIMARY_DELAY_MS || 30_000));
    res.on("close", () => {
      clearTimeout(timer);
      if (!sent) log({ requestNumber, scenario, event: "primary-connection-closed-before-response" });
    });
    return;
  }

  if (hasAdvise && (scenario === "slow-advisor" || (scenario === "advice-then-slow" && currentCalledTools.includes("advise")))) {
    let sent = false;
    const timer = setTimeout(() => {
      if (res.destroyed) return;
      sent = true;
      sendSse(res, [chunk(id, { role: "assistant", content: "Late advisor response." }), chunk(id, {}, "stop")]);
    }, Number(process.env.ADVISOR_DELAY_MS || 30_000));
    res.on("close", () => {
      clearTimeout(timer);
      if (!sent) log({ requestNumber, scenario, event: "advisor-connection-closed-before-response" });
    });
    return;
  }

  const callTool = (name, args) => sendSse(res, [
    chunk(id, {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: `call-${name}-${requestNumber}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    }),
    chunk(id, {}, "tool_calls"),
  ]);

  if (hasAdvise && scenario === "failed-tool-stream-recovery" && advisorRequestNumber === 1) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(chunk(id, {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: `call-read-${requestNumber}`,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: readPath }) },
      }],
    }))}\n\n`);
    res.end("data: {deliberately-invalid-json}\n\n");
    return;
  }

  if (!hasAdvise && scenario === "tool-abort-blocker" && primaryRequestNumber === 1) {
    callTool("bash", { command: "sleep 30" });
    return;
  }

  if (hasAdvise && scenario === "context-window" && !currentCalledTools.includes("read")) {
    if (!readPath) throw new Error("READ_PATH is required for the context-window scenario");
    callTool("read", { path: readPath });
    return;
  }

  if (hasAdvise && !currentCalledTools.includes("advise")) {
    const secondUpdate = advisorRequestNumber > 2 || allText.includes("second fixture response");
    callTool("advise", {
      note: secondUpdate
        ? "Second OMP context cycle sentinel: prior tool history was evicted without breaking call/result pairing."
        : "OMP compatibility sentinel: the external pi-omp-advisor observed the completed primary turn.",
      severity: scenario === "primary-abort-blocker" || scenario === "tool-abort-blocker" ? "blocker" : "nit",
      ShortTitle: secondUpdate ? "Second context cycle" : "OMP extension sentinel",
    });
    return;
  }

  const text = hasAdvise ? "Advisor review complete." : "PRIMARY_COMPAT_OK";
  sendSse(res, [chunk(id, { role: "assistant", content: text }), chunk(id, {}, "stop")]);
});

if (logPath) writeFileSync(logPath, "");
server.listen(port, "127.0.0.1", () => {
  console.log(`fake-openai-ready http://127.0.0.1:${port}/v1`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
