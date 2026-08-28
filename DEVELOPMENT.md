# Development

## How this is installed (and why not npm)

Every machine runs a **local, editable checkout** at `$HOME/git/pi-omp-advisor`,
registered as a local-path package:

```json
{ "packages": ["../../git/pi-omp-advisor"] }
```

That path is resolved by pi against `~/.pi/agent`, so it means
`$HOME/git/pi-omp-advisor` on **any** machine regardless of what `$HOME` is. One
synced `settings.json` therefore carries this install everywhere without
hard-coding anyone's paths.

To set up a new machine:

```bash
./scripts/bootstrap-machine.sh
# or, with no checkout yet:
curl -fsSL https://raw.githubusercontent.com/Scott-Meyer/pi-omp-advisor/main/scripts/bootstrap-machine.sh | bash
```

It clones or fast-forwards the checkout, installs production dependencies, and
adds the settings entry. It is idempotent, and it refuses to touch a checkout with
uncommitted changes.

**Why not `pi install npm:` or `pi install git:`.** Both hand you a pi-managed
copy you must not edit:

- `npm:` means a publish round-trip for every change.
- `git:` clones into `~/.pi/agent/git/`, and pi's updater runs `git reset --hard`
  followed by `git clean -fdx` in that clone (`package-manager.js`) — any local
  edit or untracked file is destroyed on the next update.

A local-path entry keeps the install and the working tree the same directory, so
edits are live and updates are `git pull`.

**Do not list more than one entry for this project.** pi keys package identity
separately for local paths (resolved absolute path), git URLs, and npm names, so a
local path *plus* a `git:`/`npm:` spec loads the extension twice and both copies
register `/advisor`. The bootstrap script warns if it sees a rival entry.

**What pi does not do for local-path packages:** install dependencies. Only `npm:`
and `git:` specs get an `npm install`. The checkout needs its own `node_modules`,
or `yaml` will not resolve and every `WATCHDOG.yml` is silently ignored (the
advisor degrades rather than crashing, so this fails quietly). That is the single
reason the bootstrap script exists rather than just documenting a `git clone`.

## Optional: publishing to npm

**Remember to do this.** Right now pi-omp-advisor is installed by a local path entry in
`~/.pi/agent/settings.json`:

```json
{ "packages": ["../../git/pi-omp-advisor"] }
```

Publishing is **not** required for the setup above, and is only worth doing if you
want other people to install this. For your own machines, prefer the checkout
workflow — it avoids a publish round-trip per change.

If you do publish, note what a local path entry cannot do on its own:

- Tooling that syncs an agent config across machines typically copies
  `settings.json` and friends, not your working tree. The remote machine then has
  a `packages` entry pointing at a path that does not exist there, and pi reports
  a missing package. `~/.pi/agent/npm/package.json` is not synced either, so
  "just add the dependency there" fixes only the machine in front of you.
- Copying `src/` into `~/.pi/agent/extensions/` instead is what caused the
  "Cannot find module 'yaml'" bug: that directory gets no dependency install, so
  `yaml` resolved only by accident (see "Dependencies" below).

The fix is to publish the package so the spec in `settings.json` is
self-installing, because pi runs `npm install` for npm and git specs:

- [ ] publish to npm as `pi-omp-advisor`, then `pi install npm:pi-omp-advisor`, **or**
- [ ] push to a git remote and use `pi install git:github.com/<user>/pi-omp-advisor@<tag>`

Until one of those is done, every other machine needs a manual checkout.

## Dependencies

pi provides exactly these to extensions — import them bare, list them in
`peerDependencies` with `"*"`, and never bundle them:

`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`

(`typebox` is genuinely the right name here — it is pi's own dependency. Do not
"correct" it to `@sinclair/typebox`.)

Anything else is a real dependency that must travel with the package. Today that
is just `yaml`. Rules:

1. Declare it in `dependencies`.
2. Load it defensively. An extension that throws while loading takes down the
   **entire pi session** — no pi at all, not just no advisor. `yaml` is loaded
   through `requireYaml()` in `src/advisor/watchdog-config.ts`, which degrades to
   "ignore `WATCHDOG.yml`, keep `WATCHDOG.md`" and logs something actionable.
   Any new third-party dependency should follow that pattern.
3. Never assume hoisting. `~/.pi/agent/npm/node_modules` happens to contain
   `yaml` on some machines because an unrelated package pulled it up. That is not
   a contract.

## Verifying a change

```bash
./node_modules/.bin/tsc -p tsconfig.json     # must be clean
```

Then an end-to-end headless run, in a scratch directory, against a file with an
obvious defect so the advisor actually has something to say:

```bash
mkdir -p /tmp/advisor-smoke && cd /tmp/advisor-smoke
echo 'export const add = (a: number, b: number) => a - b;' > math.ts
timeout 180 pi -p "Read math.ts and say what add() does." > /tmp/out 2>/tmp/err
echo "EXIT=$?"
```

**Capture the exit code directly — do not pipe pi into `tail`/`head`.** `$?` and
your background-runner's reported status then describe the *pipe's last command*, not pi. This
turned a run that hit its timeout into an apparent "exit 0" twice while
diagnosing the headless hang below.

What to check:

- `EXIT=0`, and elapsed time close to the no-advisor baseline. `EXIT=124` is a
  timeout, i.e. pi could not exit.
- `/tmp/err` empty. Routine advisor state must not be narrated to stderr; it
  lands in the user's transcript.

A clean run proves loading and teardown, **not** delivery. To check delivery, use
the trace — not the session file:

```bash
PI_ADVISOR_DEBUG=1 timeout 240 pi -p "..." 2>&1 | grep pi-omp-advisor
```

```
[advisor:debug] advise() called severity=concern note="..."
[advisor:debug] route advisor=advisor severity=concern -> channel=preserve (streaming=false preserveOnly=true immune=false)
```

The first line proves the advisor has a working `advise` tool; the second proves
the guard admitted the note and shows which channel it took.

**Do not use `"customType":"advisor"` in the session jsonl as the headless
success signal.** Headless runs set `preserveOnly`, so a `concern` routes to
`preserve`, which sends with `deliverAs: "nextTurn"` — and a print run has no
next turn, so the message never materializes into the session file. Zero
advisor messages there is *expected* in print mode and does not mean delivery
failed. (Chasing that signal is what made a totally inert advisor look like
five different bugs.)

To exercise the `steer` path instead, the primary must still be streaming when
the note arrives — give it a long multi-step task (read several files one at a
time) so its turn outlives the advisor's round trip.

To force a note on demand, drop a project-scope `WATCHDOG.yml` in the scratch
directory whose `instructions:` require exactly one `advise` call. Discovery
walks up from cwd, and a project entry replaces a user-scope advisor with the
same name.

Baseline for comparison: run with `~/.pi/agent/WATCHDOG.yml` moved aside, so no
roster is discovered and the orchestrator stays inactive. Compare like with
like: the same prompt both times. A trivial prompt ("say ok") does not exercise
the advisor at all and will pass even when something is badly broken.

## Traps already hit here

- **`createAgentSession`'s `tools` option is an ALLOWLIST, not an additive
  list.** pi sets `allowedToolNames` from it and then activates only registry
  entries whose name is in that set — **custom tools included**. Registering
  `advise` through `customTools` while passing `tools: ["read","grep","find"]`
  silently filtered it out, so the advisor could read the whole primary
  transcript and was physically unable to say anything about it. The port shipped
  that way and consequently never delivered a single advisory. Guarded now by
  `withAdviseTool()` in `src/advisor/orchestrator.ts`; if you ever touch tool
  resolution, re-run the forced-advise trace above and confirm the
  `advise() called` line still appears.

- **Advisor sessions must stay isolated.** `DefaultResourceLoader` defaults every
  `no*` discovery flag to `false`, and `createAgentSession` feeds
  `resourceLoader.getExtensions()` into the session it builds. Without
  `ADVISOR_RESOURCE_ISOLATION` (`src/advisor/orchestrator.ts`) each advisor boots
  the user's whole global extension stack — MCP servers, IPC sockets,
  telemetry timers — inside a throwaway watcher context. That is what made
  headless pi hang forever instead of exiting: nested MCP child processes kept
  the event loop alive past teardown.
- **The emission guard must gate at the tool-call boundary**, not inside the
  orchestrator's delivery callback. `AdviseState.#deliver` records a note as
  delivered *before* invoking the callback, so gating downstream marks notes
  delivered that were never routed and permanently dedupe-blocks them.
- **Upstream defaults are in `settings-schema.ts`, not in prose.** Two were
  silently wrong here: `advisor.syncBacklog` defaults to `off` (this port had it
  hardcoded on at threshold 3) and `advisor.immuneTurns` defaults to `3` (this
  port had 1). When in doubt, read upstream's published source rather than guessing —
  see `PROVENANCE.md` for what is a port versus a copy.
- **The advisor's own transcript is invisible to the user.** Its `read`/`grep`
  calls and its `advise()` call happen in a separate `AgentSession`. Only the
  delivered `<advisory>` message appears, rendered by
  `pi.registerMessageRenderer("advisor", …)`. Debug logging is the only window
  into what the advisor actually did — which is why routine stderr chatter is
  tempting, and still wrong.
