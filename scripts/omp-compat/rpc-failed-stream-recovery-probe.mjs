import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const [omp, cwd, outputPath] = process.argv.slice(2);
if (!omp || !cwd || !outputPath) throw new Error("usage: rpc-failed-stream-recovery-probe.mjs <omp> <cwd> <output-json>");

const child = spawn(omp, ["--mode", "rpc", "--no-session", "--model", "compat/compat-model", "--cwd", cwd], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
const events = [];
let stderr = "";
let secondSent = false;
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
  if (stderr.includes("advisor turn failed") && !secondSent) {
    secondSent = true;
    setTimeout(() => send({ id: "second", type: "prompt", message: "Return the second fixture response." }), 200);
  }
  if (secondSent && stderr.includes("route advisor=")) finishSoon();
});
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  let event;
  try { event = JSON.parse(line); } catch { event = { invalidJsonLine: line }; }
  events.push(event);
  if (event.type === "ready") send({ id: "first", type: "prompt", message: "Return the first fixture response." });
});

const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
const result = await new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
const routeCount = (stderr.match(/route advisor=/g) || []).length;
const failureCount = (stderr.match(/advisor turn failed/g) || []).length;
writeFileSync(outputPath, `${JSON.stringify({ result, secondSent, routeCount, failureCount, stderr, events }, null, 2)}\n`);
console.log(JSON.stringify({ result, secondSent, routeCount, failureCount, stderr }, null, 2));
if (!secondSent || failureCount !== 1 || routeCount < 1) process.exitCode = 1;
