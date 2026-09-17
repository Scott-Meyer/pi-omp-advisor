import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const [omp, cwd, outputPath] = process.argv.slice(2);
const resumePrompt = process.env.RESUME_PROMPT || "This is a normal user resume; return the second fixture response.";
if (!omp || !cwd || !outputPath) {
  throw new Error("usage: node rpc-tool-abort-probe.mjs <omp> <cwd> <output-json>");
}

const child = spawn(omp, [
  "--mode", "rpc",
  "--no-session",
  "--model", "compat/compat-model",
  "--cwd", cwd,
  "--approval-mode", "yolo",
], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

const events = [];
let stderr = "";
let primarySent = false;
let abortSent = false;
let resumed = false;
let routeCount = 0;
let finishScheduled = false;
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const finishSoon = () => {
  if (finishScheduled) return;
  finishScheduled = true;
  setTimeout(() => child.kill("SIGTERM"), 700);
};

child.stderr.setEncoding("utf8");
child.stderr.on("data", data => {
  stderr += data;
  routeCount = (stderr.match(/route advisor=/g) || []).length;
  if (routeCount >= 1 && !resumed) {
    resumed = true;
    setTimeout(() => send({ id: "resume", type: "prompt", message: resumePrompt }), 200);
  }
  if (routeCount >= 2) finishSoon();
});

const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  let event;
  try { event = JSON.parse(line); }
  catch { event = { invalidJsonLine: line }; }
  events.push(event);

  if (event.type === "ready" && !primarySent) {
    primarySent = true;
    send({ id: "primary", type: "prompt", message: "Run the fixture's long operation." });
  }
  if (event.type === "tool_execution_start" && event.toolName === "bash" && !abortSent) {
    abortSent = true;
    setTimeout(() => send({ id: "abort", type: "abort" }), 300);
  }
});

const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
const result = await new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
const report = { result, primarySent, abortSent, resumed, routeCount, stderr, events };
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  result,
  primarySent,
  abortSent,
  resumed,
  routeCount,
  stderr,
  abortResponse: events.find(event => event.type === "response" && event.id === "abort"),
  toolStarts: events.filter(event => event.type === "tool_execution_start"),
  toolEnds: events.filter(event => event.type === "tool_execution_end"),
  agentEnds: events.filter(event => event.type === "agent_end"),
  promptResults: events.filter(event => event.type === "prompt_result"),
}, null, 2));
