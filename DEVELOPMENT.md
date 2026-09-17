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

## Releasing to npm

Pushing a new `v<version>` tag runs `.github/workflows/publish.yml`. GitHub tests
and packs that tagged source, then publishes the same tarball through npm trusted
publishing (OIDC). Collaborators with permission to push tags, including Sean,
can release without an npm account login or an `NPM_TOKEN` secret.

From a clean, up-to-date `main` with the release changes committed:

```bash
npm version patch --no-git-tag-version  # or choose an explicit version
VERSION=$(node -p 'require("./package.json").version')
git add package.json package-lock.json
git commit -S -m "Release v$VERSION"
git tag -s "v$VERSION" -m "pi-omp-advisor v$VERSION"
git push origin main "v$VERSION"
```

The tag and both lockfile version fields must match `package.json`. Stable
versions publish to `latest`; prereleases such as `v0.3.0-rc.1` publish to `next`.
The workflow also attaches npm provenance. Follow the **Publish to npm** run in
GitHub Actions to confirm publication. A GitHub Release page is optional and
separate from the npm publish.

Use `gh workflow run publish.yml --ref main` to run validation and packaging
without publishing. This checks the build path, not the npm OIDC exchange; that
last step is exercised by the next new release tag. Existing tags are not
retroactively published. Keep published versions and release tags immutable;
fix a failed check before creating the next version rather than moving a tag.

### One-time owner setup

The npm package's GitHub trusted publisher is bound to:

- Repository: `Scott-Meyer/pi-omp-advisor`
- Workflow filename: `publish.yml` (not the full path)
- Environment: `npm`

The GitHub `npm` environment permits only `v*` tags and has no required reviewer,
so a collaborator can release without waiting for the owner. Treat tag-push and
workflow-edit access as publishing authority. Only the publish job has
`id-token: write`; it installs no project dependencies and executes no package
lifecycle scripts. The workflow uses GitHub-hosted runners and an OIDC-capable
npm CLI, with no npm token stored in GitHub.

An authenticated npm package owner can register that relationship with:

```bash
npm trust github pi-omp-advisor --repo Scott-Meyer/pi-omp-advisor \
  --file publish.yml --env npm --allow-publish
npm trust list pi-omp-advisor
```

Changing the repository, workflow filename, or environment requires updating the
npm trust relationship too. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

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
`preserve`, which stays in the extension-owned Advisor inbox — and a print run
has neither a visible inbox nor a next interactive prompt that releases it.
Zero advisor messages there is *expected* in print mode and does not mean
delivery failed. (Chasing that signal is what made a totally inert advisor look
like five different bugs.)

For an inbox/UI change, also test interactively: force a late `nit` or `concern`, verify
the widget appears above the editor, open it with `Ctrl+Shift+A`, dismiss one
note, then submit a normal prompt and verify every remaining advisor card renders
above that user message. Pause with `Ctrl+Shift+R`, submit a prompt, and verify
queued notes remain while no new advisor work starts; resume with the same key.
Finally, verify `Ctrl+Shift+X` clears the queue without a confirmation dialog.
Type `/advisor`, press Tab to accept it and insert its argument space, then
type `pau` and press Tab to verify it completes to `/advisor pause`; submit bare
`/advisor` and verify the control menu opens with help and config reachable from
it. Pi's public TUI
components expose keyboard input but no pointer hit-testing, so
a literal clickable `×` requires a pi-core API change.

The card-above-prompt guarantee is exact for an accepted idle prompt: pi runs
`input` before constructing the user message, and `sendMessage` appends the card
synchronously. Pi currently has no hook between successful prompt preflight and
user-message construction. Consequently, if a *later* input handler consumes
the prompt or model/auth preflight fails, a released card can appear without a
following user message. Making release transactional in that rare failure path
also requires a pi-core API change; moving release to `before_agent_start` would
put the card below the user message and is not an acceptable workaround.

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

## Late-delivery and interruption checks

Routing tests cover ordinary late notes, active-run delivery, and the blocker
exception after natural completion. Orchestrator regressions read, dismiss, and
clear real pending notes; hold the microtask handoff across completion/abort; and
use a real SDK Agent abort to verify that a newly built advisor cannot restart a
stopped primary after its signal disappears. A normal user resume restores the
existing blocker behavior.

These are not keyboard-automation tests. After reloading, separately exercise
Escape during a primary run and a delayed advisory. The latch observes the
Agent's public abort signal, not Escape used to close an editor/menu or cancel
Pi's separate retry/compaction operations.

## Bounded-context checks

The advisor's memory budget applies at the public `Agent.transformContext` hook,
not just at the incoming observation queue. `context-window.test.ts` uses a real
SDK Agent with a controlled stream to inspect the next model request after a
large investigative result. It also checks expiration, explicit shortening,
complete tool exchanges, model headroom, failed partial-call recovery, and real
parallel/sequential multi-call interruption. Request assertions run outside the
SDK callback, where the SDK cannot swallow them as model errors; the orchestrator
fixture also records callback assertion failures and fails its test afterward.
Alias regressions alternate raw and shortened histories and exercise a context
hook that evicts a shortened exchange. Revision regressions verify duplicate
tracking and the new-note allowance before and after advisor reconstruction.

The orchestrator tests load actual YAML, exercise the primary-reasoning default
and opt-in, and verify that pending advice survives history eviction. These are
mechanical checks, not proof that a smaller context improves model judgment.
After `/reload`, inspect `/advisor status` and the config controls; use normal
cooperative work to judge whether the advisor remains useful with the narrower
view. No prior primary reasoning should be replayed merely to fill the budget.

## Live cancellation check

After `/reload`, confirm the advisor has the explicit `request_stop` grant.
Agree on a harmless foreground sleep and ask the advisor to inspect `current_tool`
and request cancellation of that exact `targetId` with a diagnostic reason.
Leave a short tool boundary before the sleep so the agreement can reach it.
The stop-enabled observer also receives the sleep's tool-start update.

Look for the visible request reason, the real tool's abort result before its
sleep finishes, and the runtime stop receipt. No note or claim by either model
alone establishes that cancellation succeeded. Do not substitute a detached
background sleep: this capability cancels the current primary turn, not detached
jobs. A fallback timeout should be recorded separately from advisor cancellation.

`primary-stop.test.ts` checks the scope guards and cancels a real SDK bash sleep;
that protects the mechanics but does not replace this two-model session test.

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
- **The emission guard gates new notes at the tool-call boundary**, not during
  a deferred flush. Each deferred note already spent its update's allowance (up to
  3 accepted notes per review cycle). Revisions and updates edit a held note or
  follow up and do not spend a new-note slot.
- **Review before release.** `beginUpdate` leaves deferred advice editable.
  A completed review calls `finishUpdate` to release accepted notes into the
  delivery channels (steer for concerns during active work, aside for nits,
  and preserve to inbox only after primary settlement). Truncated/deferred
  responses, errors, pauses, and stale runtime generations cannot flush them
  and forget their discarded text in the emission guard so retracted or failed
  notes are not permanently blackholed.
  Context rebuilds reuse the pending state and wire the forget callback.
  Reviews call `Agent.prompt` directly, so cancellation uses `Agent.abort` and
  `Agent.waitForIdle` too; the `AgentSession` wrapper's separate streaming flag
  does not track that run. The deterministic session-boundary tests in
  `orchestrator.test.ts` exercise actual tool registration and delivery without
  a live provider.
- **Handoff is the recall boundary, not model consumption.** Pending tools can
  edit extension-held notes only. Resolve inbox menu snapshots against current
  IDs just before sending, so revisions and withdrawals cannot leak stale text.
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
