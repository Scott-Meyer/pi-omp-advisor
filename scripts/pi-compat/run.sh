#!/usr/bin/env bash
# Inbox delivery through the real, installed `pi` binary with an isolated
# agent dir and a deterministic local provider. Never touches ~/.pi.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
failures=0

check() { # scenario expected-json-predicate description
  local scenario=$1 predicate=$2 description=$3
  local W; W=$(mktemp -d "${TMPDIR:-/tmp}/pi-compat.XXXX")
  export HOME=$W/home PI_CODING_AGENT_DIR=$W/home/.pi/agent
  mkdir -p "$PI_CODING_AGENT_DIR" "$W/proj"
  export PORT=$((40000 + RANDOM % 4000)) REQUEST_LOG=$W/requests.jsonl
  : > "$REQUEST_LOG"
  node "$HERE/fake-openai-server.mjs" & local server=$!
  sleep 0.5
  printf '{"providers":{"fake":{"baseUrl":"http://127.0.0.1:%s/v1","api":"openai-completions","apiKey":"x","models":[{"id":"fake"}]}}}\n' "$PORT" > "$PI_CODING_AGENT_DIR/models.json"
  printf '{"defaultProvider":"fake","defaultModel":"fake","packages":["%s"]}\n' "$REPO" > "$PI_CODING_AGENT_DIR/settings.json"
  ( cd "$W/proj" && pi -p --provider fake --model fake "hello" > "$W/first.out" 2>&1 )
  local session; session=$(ls "$PI_CODING_AGENT_DIR"/sessions/*/*.jsonl | head -1)
  # One held advisory, persisted exactly as the extension stores it at rest.
  node -e '
    const fs = require("fs"); const [file, paused] = process.argv.slice(1);
    const parentId = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)).id;
    fs.appendFileSync(file, JSON.stringify({ type: "custom", customType: "pi-omp-advisor-inbox", id: "seed0001", parentId,
      timestamp: new Date().toISOString(),
      data: { version: 1, paused: paused === "1", items: [{ id: 1, adviceId: "a1", note: "HELD-NOTE: check the retry path", severity: "concern" }] } }) + "\n");
  ' "$session" "$([ "$scenario" = paused-resume ] && echo 1 || echo 0)"
  : > "$REQUEST_LOG"
  local result
  result=$(cd "$W/proj" && node "$HERE/inbox-probe.mjs" "$session" "$scenario" "$REQUEST_LOG" 2>"$W/pi.err")
  kill "$server" 2>/dev/null || true
  if node -e "const r=JSON.parse(process.argv[1]); process.exit(($predicate)(r) ? 0 : 1)" "$result"; then
    echo "ok   $scenario: $description"
  else
    echo "FAIL $scenario: $description"; echo "     $result"; echo "     work dir: $W"; failures=$((failures + 1))
  fi
}

# Each predicate inspects what the primary model was sent and the inbox at exit.
check wake 'r => r.inboxAtExit === 0 && r.requests[0]?.join() .endsWith("PEER,NOTE")' \
  "a run started by a peer message gets the held note before its first response"
PRIMARY_DELAY_MS=2500 check paused-resume 'r => r.inboxAtExit === 0 && !r.requests[0].includes("NOTE") && r.requests.length === 2 && r.requests[1].filter(l => l === "NOTE").length === 1' \
  "resuming mid-run delivers the note into that same run"
check prompt 'r => r.inboxAtExit === 0 && r.requests.length === 1 && r.requests[0].join().endsWith("NOTE,PROMPT")' \
  "a person's prompt gets the held note above it, once"
check manual 'r => r.inboxAtExit === 0 && r.requests.length === 1 && r.requests[0].filter(l => l === "NOTE").length === 1' \
  "Deliver all from the inbox starts one turn with the note exactly once"

echo "pi $(pi --version)"
exit $failures
