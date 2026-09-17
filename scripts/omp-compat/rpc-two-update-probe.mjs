import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const [omp, cwd, outputPath] = process.argv.slice(2);
if (!omp || !cwd || !outputPath) {
  throw new Error("usage: node rpc-two-update-probe.mjs <omp> <cwd> <output-json>");
}

const child = spawn(omp, [
  "--mode", "rpc",
  "--no-session",
  "--model", "compat/compat-model",
  "--cwd", cwd,
], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const events = [];
let stderr = "";
let routeCount = 0;
let secondSent = false;
let finishScheduled = false;
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const finishSoon = () => {
  if (finishScheduled) return;
  finishScheduled = true;
  setTimeout(() => child.kill("SIGTERM"), 500);
};

child.stderr.setEncoding("utf8");
child.stderr.on("data", data => {
  stderr += data;
  routeCount = (stderr.match(/route advisor=/g) || []).length;
  if (routeCount >= 1 && !secondSent) {
    secondSent = true;
    setTimeout(() => send({ id: "second", type: "prompt", message: "Return the second fixture response." }), 200);
  }
  if (routeCount >= 2) finishSoon();
});
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  let event;
  try { event = JSON.parse(line); }
  catch { event = { invalidJsonLine: line }; }
  events.push(event);
  if (event.type === "ready") {
    send({ id: "first", type: "prompt", message: "Return the first fixture response." });
  }
});

const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
const result = await new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
const report = { result, routeCount, secondSent, stderr, events };
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  result,
  routeCount,
  secondSent,
  stderr,
  promptResponses: events.filter(event => event.type === "response" && ["first", "second"].includes(event.id)),
  agentEnds: events.filter(event => event.type === "agent_end").length,
}, null, 2));
if (routeCount !== 2 || !secondSent || /advisor turn failed/.test(stderr)) process.exitCode = 1;
