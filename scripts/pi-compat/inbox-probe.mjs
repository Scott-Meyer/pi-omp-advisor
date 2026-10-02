// Drives one scenario through a real `pi --mode rpc` on a session that already
// holds one advisory in the inbox, then reports what the primary model saw.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";

const [session, scenario, requestLog] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const wakes = scenario === "wake" || scenario === "paused-resume";
const child = spawn("pi", ["--mode", "rpc", "--provider", "fake", "--model", "fake", "--session", session, "-e", path.join(here, "wake-extension.ts")], {
  env: { ...process.env, INBOX_PROBE_WAKE: wakes ? "1" : "0" },
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdin.on("error", () => {});
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
readline.createInterface({ input: child.stdout }).on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== "extension_ui_request") return;
  if (message.method === "select") send({ type: "extension_ui_response", id: message.id, value: message.options.find(o => o.startsWith("Deliver all")) });
  else if (["confirm", "input", "editor"].includes(message.method)) send({ type: "extension_ui_response", id: message.id, cancelled: true });
});

if (scenario === "prompt") setTimeout(() => send({ type: "prompt", message: "USER-PROMPT go" }), 1000);
if (scenario === "manual") setTimeout(() => send({ type: "prompt", message: "/advisor inbox" }), 1000);
if (scenario === "paused-resume") setTimeout(() => send({ type: "prompt", message: "/advisor resume" }), 2500);

await new Promise(resolve => setTimeout(resolve, 8000));
child.kill();

const text = m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const primary = readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.advisor);
const label = m => text(m).includes("HELD-NOTE") ? "NOTE" : text(m).includes("PEER-WAKE") ? "PEER" : text(m).includes("USER-PROMPT") ? "PROMPT" : m.role;
const entries = readFileSync(session, "utf8").trim().split("\n").map(l => JSON.parse(l));
const inbox = [...entries].reverse().find(e => e.customType === "pi-omp-advisor-inbox");
console.log(JSON.stringify({
  requests: primary.map(r => r.messages.map(label).filter(l => l !== "system")),
  inboxAtExit: inbox.data.items.length,
}));
