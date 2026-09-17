import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [omp, cwd, command = "/pi-advisor status"] = process.argv.slice(2);
if (!omp || !cwd) throw new Error("usage: node rpc-command-probe.mjs <omp> <cwd> [command]");

const child = spawn(omp, [
  "--mode", "rpc",
  "--no-session",
  "--model", "compat/compat-model",
  "--cwd", cwd,
], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

const events = [];
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", data => { stderr += data; });
const lines = createInterface({ input: child.stdout });
lines.on("line", line => {
  try {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "response" && event.id === "probe" && event.success) {
      setTimeout(() => child.kill("SIGTERM"), 150);
    }
  } catch {
    events.push({ invalidJsonLine: line });
  }
});

child.stdin.write(`${JSON.stringify({ id: "probe", type: "prompt", message: command })}\n`);
const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
const result = await new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
clearTimeout(timer);
console.log(JSON.stringify({ command, result, stderr, events }, null, 2));
