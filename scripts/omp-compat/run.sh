#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OMP_BIN=${OMP_BIN:-omp}
EXPECTED_OMP_VERSION=${EXPECTED_OMP_VERSION:-18.2.4}
PACKAGE_SPEC=${OMP_COMPAT_PACKAGE_SPEC:-}
KEEP_OMP_COMPAT_WORK=${KEEP_OMP_COMPAT_WORK:-0}
WORK=${OMP_COMPAT_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pi-omp-advisor-omp.XXXXXX")}
SERVER_PID=
CURRENT_REQUEST_LOG=

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP_OMP_COMPAT_WORK" != "1" && -z "${OMP_COMPAT_WORK_DIR:-}" ]]; then
    rm -rf "$WORK"
  else
    printf 'OMP compatibility artifacts: %s\n' "$WORK"
  fi
}
trap cleanup EXIT

OMP_BIN=$(command -v "$OMP_BIN")
actual_version=$($OMP_BIN --version | sed -E 's#^omp[/ v]+##')
if [[ "$actual_version" != "$EXPECTED_OMP_VERSION" ]]; then
  printf 'Expected OMP %s, got %s. Override EXPECTED_OMP_VERSION intentionally when validating another release.\n' "$EXPECTED_OMP_VERSION" "$actual_version" >&2
  exit 1
fi

mkdir -p "$WORK/pack" "$WORK/stage" "$WORK/home/.omp/agent" "$WORK/project/.omp/skills/resume-check" "$WORK/zero-config-project"
printf '{"private":true}\n' >"$WORK/stage/package.json"
if [[ -n "$PACKAGE_SPEC" ]]; then
  npm view "$PACKAGE_SPEC" version dist.integrity dist.shasum dist.tarball --json >"$WORK/npm-registry-dist.json"
  tarball=$(npm pack "$PACKAGE_SPEC" --silent --pack-destination "$WORK/pack")
else
  tarball=$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK/pack")
fi
npm install --prefix "$WORK/stage" --ignore-scripts --no-audit --no-fund "$WORK/pack/$tarball" >/dev/null
shasum -a 256 "$WORK/pack/$tarball" >"$WORK/package-sha256.txt"
if [[ -n "$PACKAGE_SPEC" ]]; then
  node - "$WORK/npm-registry-dist.json" "$WORK/pack/$tarball" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const metadataValue = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const metadata = Array.isArray(metadataValue) ? metadataValue[0] : metadataValue;
const expectedSha1 = metadata?.dist?.shasum ?? metadata?.["dist.shasum"];
const expectedIntegrity = metadata?.dist?.integrity ?? metadata?.["dist.integrity"];
const tarball = fs.readFileSync(process.argv[3]);
const sha1 = crypto.createHash("sha1").update(tarball).digest("hex");
const integrity = `sha512-${crypto.createHash("sha512").update(tarball).digest("base64")}`;
if (sha1 !== expectedSha1 || integrity !== expectedIntegrity) {
  throw new Error("downloaded package checksums do not match npm registry metadata");
}
NODE
fi

export HOME="$WORK/home"
export PI_CODING_AGENT_DIR="$HOME/.omp/agent"
export PI_ADVISOR_DEBUG=1
export OMP_SKIP_SETUP=1

"$OMP_BIN" install "$WORK/stage/node_modules/pi-omp-advisor" --json >"$WORK/install.json"
cat >"$PI_CODING_AGENT_DIR/config.yml" <<'YAML'
advisor:
  enabled: false
modelRoles:
  default: compat/saved-default-model
YAML

PORT=${OMP_COMPAT_PORT:-$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)}
cat >"$PI_CODING_AGENT_DIR/models.yml" <<YAML
providers:
  compat:
    baseUrl: http://127.0.0.1:${PORT}/v1
    api: openai-completions
    auth: none
    models:
      - id: compat-model
        name: OMP Compatibility Fixture
        reasoning: true
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 4096
      - id: saved-default-model
        name: Deliberately Different Saved Default
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 128000
        maxTokens: 4096
YAML
cat >"$WORK/project/WATCHDOG.yml" <<'YAML'
main: true
maxBehind: 1
flushOnSettled: true
advisors:
  - name: extension-sentinel
    model: compat/compat-model
    tools: [read, request_stop]
    contextTokens: 8192
    instructions: Review the observed turn and call advise once with a short title.
YAML
cat >"$WORK/project/.omp/skills/resume-check/SKILL.md" <<'MARKDOWN'
---
name: resume-check
description: Deterministic OMP compatibility resume probe.
---

Return the second fixture response exactly as requested.
MARKDOWN
python3 - "$WORK/project/large-context-fixture.txt" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text("BEGIN_LARGE_READ\n" + "0123456789abcdef" * 2200 + "\nEND_LARGE_READ\n")
PY

start_server() {
  local scenario=$1 log=$2
  stop_server
  rm -f "$log" "$WORK/server.log"
  CURRENT_REQUEST_LOG=$log
  PORT="$PORT" SCENARIO="$scenario" READ_PATH="$WORK/project/large-context-fixture.txt" REQUEST_LOG="$log" \
    node "$ROOT/scripts/omp-compat/fake-openai-server.mjs" >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in {1..100}; do
    grep -q 'fake-openai-ready' "$WORK/server.log" 2>/dev/null && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || { cat "$WORK/server.log" >&2; return 1; }
    sleep 0.02
  done
  printf 'Fixture server did not become ready.\n' >&2
  return 1
}

stop_server() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=
  if [[ -n "${CURRENT_REQUEST_LOG:-}" ]] && grep -q '"event":"invalid-tool-pairing"' "$CURRENT_REQUEST_LOG" 2>/dev/null; then
    printf 'Provider rejected invalid tool-call/result history:\n' >&2
    grep '"event":"invalid-tool-pairing"' "$CURRENT_REQUEST_LOG" >&2
    return 1
  fi
  CURRENT_REQUEST_LOG=
}

run_print() {
  local output=$1 stderr=$2
  (cd "$WORK/project" && "$OMP_BIN" --model compat/compat-model --no-session -p "Reply exactly PRIMARY_COMPAT_OK.") >"$output" 2>"$stderr"
}

printf '[1/9] fresh install starts an implicit advisor on the active chat model\n'
start_server direct-advice "$WORK/zero-config.requests.jsonl"
(cd "$WORK/zero-config-project" && "$OMP_BIN" --model compat/compat-model --no-session -p "Reply exactly PRIMARY_COMPAT_OK.") >"$WORK/zero-config.out" 2>"$WORK/zero-config.err"
node - "$WORK/zero-config.requests.jsonl" "$WORK/zero-config.out" <<'NODE'
const fs = require("fs");
const [log, out] = process.argv.slice(2);
const rows = fs.readFileSync(log, "utf8").trim().split(/\n/).map(JSON.parse);
const primary = rows.filter(row => !row.advisorRequest);
const advisor = rows.filter(row => row.advisorRequest);
if (fs.readFileSync(out, "utf8").trim() !== "PRIMARY_COMPAT_OK") throw new Error("unexpected zero-config primary output");
if (primary.length < 1 || advisor.length < 2) throw new Error(`fresh install did not run the implicit advisor: ${JSON.stringify(rows.map(row => row.advisorRequest))}`);
if (!primary.every(row => row.model === "compat-model") || !advisor.every(row => row.model === "compat-model")) throw new Error(`implicit advisor used the saved default instead of the active --model selection: ${JSON.stringify(rows.map(row => row.model))}`);
NODE
stop_server

printf '[2/9] implicit advisor follows an interactive chat-model switch\n'
start_server direct-advice "$WORK/model-switch.requests.jsonl"
node "$ROOT/scripts/omp-compat/rpc-model-switch-probe.mjs" "$OMP_BIN" "$WORK/zero-config-project" "$WORK/model-switch.rpc.json" >"$WORK/model-switch.probe.txt"
node - "$WORK/model-switch.requests.jsonl" <<'NODE'
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).map(JSON.parse);
const primaryModels = rows.filter(row => !row.advisorRequest).map(row => row.model);
const advisorModels = rows.filter(row => row.advisorRequest).map(row => row.model);
if (primaryModels[0] !== "compat-model" || primaryModels.slice(1).some(model => model !== "saved-default-model")) throw new Error(`unexpected primary model sequence: ${JSON.stringify(primaryModels)}`);
if (!advisorModels.includes("compat-model") || !advisorModels.includes("saved-default-model")) throw new Error(`implicit advisor did not follow the model switch: ${JSON.stringify(advisorModels)}`);
NODE
stop_server

printf '[3/9] npm-packed install and restricted child inventory\n'
start_server direct-advice "$WORK/direct.requests.jsonl"
run_print "$WORK/direct.out" "$WORK/direct.err"
node - "$WORK/direct.requests.jsonl" "$WORK/direct.out" "$WORK/direct.err" <<'NODE'
const fs = require("fs");
const [log, out, err] = process.argv.slice(2);
const rows = fs.readFileSync(log, "utf8").trim().split(/\n/).map(JSON.parse);
const primary = rows.find(row => !row.advisorRequest);
const advisor = rows.find(row => row.advisorRequest);
const expected = ["read", "advise", "update_advice", "pending_advice", "revise_advice", "withdraw_advice"];
if (fs.readFileSync(out, "utf8").trim() !== "PRIMARY_COMPAT_OK") throw new Error("unexpected primary output");
if (JSON.stringify(advisor?.toolNames) !== JSON.stringify(expected)) throw new Error(`advisor tools were ${JSON.stringify(advisor?.toolNames)}`);
if (!primary?.toolNames.includes("bash") || !primary.toolNames.includes("write")) throw new Error("primary tools were unexpectedly restricted");
if (!rows.filter(row => row.advisorRequest).every(row => row.hasWindowNotice)) throw new Error("advisor request missed the bounded-window notice");
if (!/route advisor=/.test(fs.readFileSync(err, "utf8"))) throw new Error("extension advice was not routed");
NODE
stop_server

printf '[4/9] provider-context bounding across two large tool cycles\n'
start_server context-window "$WORK/context.requests.jsonl"
node "$ROOT/scripts/omp-compat/rpc-two-update-probe.mjs" "$OMP_BIN" "$WORK/project" "$WORK/context.rpc.json" >"$WORK/context.probe.txt"
node - "$WORK/context.requests.jsonl" <<'NODE'
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).map(JSON.parse);
const advisor = rows.filter(row => row.advisorRequest);
if (advisor.length < 4 || !advisor.every(row => row.hasWindowNotice)) throw new Error("advisor tool-loop context was not bounded on every request");
if (Math.max(...advisor.map(row => row.totalContentChars)) > 30000) throw new Error("large tool output escaped the configured context bound");
NODE
stop_server

printf '[5/9] terminal settlement ignores automatic continuation\n'
start_server empty-stop-retry "$WORK/continuation.requests.jsonl"
run_print "$WORK/continuation.out" "$WORK/continuation.err"
node - "$WORK/continuation.requests.jsonl" <<'NODE'
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).map(JSON.parse);
if (rows.length < 3 || rows[0].advisorRequest || rows[1].advisorRequest || !rows[2].advisorRequest) {
  throw new Error(`advisor flushed before OMP's automatic continuation: ${JSON.stringify(rows.map(row => row.advisorRequest))}`);
}
NODE
stop_server

printf '[6/9] tool-phase abort, inbox release, and explicit user resume\n'
start_server tool-abort-blocker "$WORK/abort.requests.jsonl"
RESUME_PROMPT="/skill:resume-check second fixture response" \
  node "$ROOT/scripts/omp-compat/rpc-tool-abort-probe.mjs" "$OMP_BIN" "$WORK/project" "$WORK/abort.rpc.json" >"$WORK/abort.probe.txt"
node - "$WORK/abort.rpc.json" "$WORK/abort.requests.jsonl" <<'NODE'
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const rows = fs.readFileSync(process.argv[3], "utf8").trim().split(/\n/).map(JSON.parse);
const routes = report.stderr.match(/route advisor=.*$/gm) ?? [];
if (!report.abortSent || !report.resumed) throw new Error("RPC abort/resume actions were not sent");
const usedSkillResume = report.events.some(event => (event.messages ?? []).some(message => message.role === "custom" && message.attribution === "user" && message.customType === "skill-prompt"));
if (!usedSkillResume) throw new Error("the resume did not exercise OMP's user-attributed custom skill message");
if (!routes[0]?.includes("channel=preserve") || !routes[1]?.includes("channel=steer")) throw new Error(`unexpected routes: ${routes.join(" | ")}`);
if (!rows.some(row => !row.advisorRequest && row.containsFirstAdvice)) throw new Error("the preserved blocker did not reach the next primary request");
const terminal = report.events.filter(event => event.type === "agent_end");
const latest = terminal.map(event => [...(event.messages ?? [])].reverse().find(message => message.role === "assistant")?.stopReason);
if (latest[0] !== "aborted" || !latest.includes("stop")) throw new Error(`unexpected run endings: ${latest}`);
NODE
stop_server

printf '[7/9] malformed advisor tool stream recovers on the next observation\n'
start_server failed-tool-stream-recovery "$WORK/failed-stream.requests.jsonl"
node "$ROOT/scripts/omp-compat/rpc-failed-stream-recovery-probe.mjs" "$OMP_BIN" "$WORK/project" "$WORK/failed-stream.rpc.json" >"$WORK/failed-stream.probe.txt"
stop_server

printf '[8/9] primary native advisor enabled without nesting inside extension child\n'
cat >"$PI_CODING_AGENT_DIR/config.yml" <<'YAML'
advisor:
  enabled: true
YAML
start_server direct-advice "$WORK/native.requests.jsonl"
run_print "$WORK/native.out" "$WORK/native.err"
node - "$WORK/native.requests.jsonl" <<'NODE'
const fs = require("fs");
const rows = fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).map(JSON.parse);
const native = rows.filter(row => JSON.stringify(row.toolNames) === JSON.stringify(["advise", "read"]));
const external = rows.filter(row => row.toolNames?.includes("update_advice"));
if (rows.length !== 5 || native.length !== 2 || external.length !== 2) {
  throw new Error(`expected primary + two native + two extension requests, got total=${rows.length}, native=${native.length}, extension=${external.length}`);
}
NODE
stop_server
cat >"$PI_CODING_AGENT_DIR/config.yml" <<'YAML'
advisor:
  enabled: false
YAML

printf '[9/9] namespaced command and host-aware help\n'
node "$ROOT/scripts/omp-compat/rpc-command-probe.mjs" "$OMP_BIN" "$WORK/project" "/pi-advisor help" >"$WORK/help.rpc.json"
node - "$WORK/help.rpc.json" <<'NODE'
const fs = require("fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const text = JSON.stringify(report.events);
if (!report.events.some(event => event.type === "response" && event.success)) throw new Error("/pi-advisor help failed");
if (!text.includes("/pi-advisor status") || /\\?\/advisor (status|config|on|help)/.test(text)) throw new Error("OMP help used the native /advisor command name");
NODE

if [[ "${RUN_TUI:-0}" == "1" ]]; then
  printf '[tui] real PTY command submission\n'
  python3 "$ROOT/scripts/omp-compat/tui-command-probe.py" "$OMP_BIN" "$WORK/project" "$WORK/tui"
fi

printf 'OMP %s compatibility: PASS (%s)\n' "$actual_version" "$WORK"
