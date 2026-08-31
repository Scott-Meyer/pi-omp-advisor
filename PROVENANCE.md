# Provenance

`pi-omp-advisor` is a from-scratch reimplementation, on pi's own `@earendil-works/pi-coding-agent`
SDK, of the advisor/watchdog system in [oh-my-pi](https://github.com/can1357/oh-my-pi)
(package `@oh-my-pi/pi-coding-agent`), pinned at **npm version `17.4.1`**
(upstream repo: `git+https://github.com/can1357/oh-my-pi.git`; upstream has no
public git tags checked for this version — pinned by the exact npm package
version installed at port time). License: MIT, Copyright (c) 2025 Mario
Zechner, (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc. — see `LICENSE`.

The following files are byte-identical copies of upstream source. They are copied
rather than paraphrased deliberately: an advisor's behavior is a function of its
exact prompt wording, so a rewrite would be a different system, not a port.
Verified per file (`ATTRIBUTION.md` in this directory is ours, so a recursive
`diff -r` of the whole directory intentionally reports it as extra):

```sh
for f in system advise-tool active-repo-watchdog context-files; do
  diff "src/prompts/$f.md" "<upstream>/src/prompts/advisor/$f.md"
done   # no output
```


- `src/prompts/system.md` ← `src/prompts/advisor/system.md`
- `src/prompts/advise-tool.md` ← `src/prompts/advisor/advise-tool.md`
- `src/prompts/active-repo-watchdog.md` ← `src/prompts/advisor/active-repo-watchdog.md`
- `src/prompts/context-files.md` ← `src/prompts/advisor/context-files.md`

The following files are ports: same algorithm/behavior, rewritten against
pi's SDK types and primitives (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) instead of omp's
internal packages (`@oh-my-pi/omptype`, `@oh-my-pi/pi-agent-core`,
`@oh-my-pi/pi-utils`, `@oh-my-pi/pi-wire`), which don't exist outside omp.
Each file's header comment cites its upstream source file(s):

- `src/advisor/emission-guard.ts` ← `src/advisor/emission-guard.ts`
- `src/advisor/advise-logic.ts` ← `src/advisor/advise-tool.ts` (pure functions)
- `src/advisor/advise-tool.ts` ← `src/advisor/advise-tool.ts` (pi `defineTool` wrapper)
- `src/advisor/session-history-format.ts` ← `src/session/session-history-format.ts`
- `src/advisor/watchdog-config.ts` ← `src/advisor/config.ts` + `src/advisor/watchdog.ts`
- `src/advisor/orchestrator.ts` ← `src/session/session-advisors.ts` (orchestration
  layer) + `src/advisor/runtime.ts` (per-advisor delta cursor, backlog, catch-up).
  This is a genuine reimplementation against pi's SDK rather than a line-for-line
  port, since upstream's version wires into omp-internal session/telemetry/store
  plumbing with no pi equivalent — verify against upstream before relying on
  line-level behavior beyond what this port's own comments document.
- `src/advisor/delta-render.ts` ← `src/advisor/delta-split.ts`
- `src/advisor/advisor-message.ts` ← `src/modes/components/advisor-message.ts`
  (`createAdvisorMessageCard`), rebuilt against pi's `registerMessageRenderer`
  hook and narrower `Theme` API
- `src/advisor/system-prompt.ts` ← `src/advisor/watchdog.ts`
  (`formatActiveRepoWatchdogPrompt` / `formatAdvisorContextPrompt`)
- `src/index.ts` ← wiring equivalent to omp's `agent-session.ts` advisor call sites

The following are original to this project, with no upstream counterpart —
copyright Scott Meyer, MIT (see `LICENSE`):

- subagent-process gating (`main:` / `subagents:` config fields,
  `PI_ADVISOR_SUBAGENTS`, the `/advisor` command surface) — see deviation 6
- advisor-session resource isolation (`ADVISOR_RESOURCE_ISOLATION`) — deviation 8
- activation on config presence (`DiscoveredAdvisors.configFound`) — deviation 9
- the pi extension host bridge in `src/index.ts` (`pi.sendMessage`,
  `pi.registerMessageRenderer`, lifecycle wiring, headless drain)
- `src/advisor/config-roundtrip.test.ts` (not shipped in the npm tarball)

## Known deviations from upstream (documented, not silent)

1. **Tool name translation**: omp's `ADVISOR_DEFAULT_TOOL_NAMES` is
   `{read, grep, glob}`. pi's built-in glob-pattern file finder is named
   `find`, not `glob` — this is the same relationship omp's own
   `normalizeToolNames` legacy-aliases (`find` → `glob`) for omp's *own*
   history, i.e. `find`/`glob` name the same tool concept across the two
   projects. `pi-omp-advisor` maps `glob` (in `WATCHDOG.yml` `tools:` lists and the
   default set) to pi's `find` tool. `read` and `grep` names match directly.
   `ls` is included as pi has no bare equivalent bundled into `read`/`find`.
2. **`Agent.steer()` exact mid-turn injection semantics** were taken from pi's
   own docs (`docs/extensions.md`, `docs/sdk.md`), not independently
   re-verified against `pi-agent-core` source in this port, since the omp-side
   spec was produced by reading omp source, not pi source. Documented mapping:
   omp `"steer"` channel → `pi.sendMessage(msg, { deliverAs: "steer", triggerTurn: true })`;
   omp `"aside"` channel → `pi.sendMessage(msg, { deliverAs: "steer" })` (no
   `triggerTurn`, so it queues at the next step boundary without forcing a
   turn when the primary is idle); omp `"preserve"` → `pi.sendMessage(msg,
   { deliverAs: "nextTurn" })` (recorded in context, delivered whenever the
   conversation next continues, no forced turn now).
3. **Multi-message delta chunking** (omp's `delta-split.ts`, built for
   provider prompt-cache locality) IS ported (`src/advisor/delta-render.ts`,
   `renderAdvisorDeltaMessages`): each batch is split into one user message
   per source message, sent to the advisor's underlying `Agent.prompt()`
   (`AgentMessage[]` form, via `session.agent.prompt(...)` since the
   higher-level `session.prompt()` wrapper only accepts a single string) —
   not collapsed into one joined string. Cache-locality behavior itself
   depends on the provider's own prompt caching, not verified here, but the
   message-boundary shape matches upstream.
4. **Session-file transcript recording** (omp's `AdvisorTranscriptRecorder`,
   `__advisor.jsonl`, its own stats/usage system) has no pi equivalent and is
   not ported — pi has its own session/transcript persistence that already
   captures the advisor's live `AgentSession` messages.
5. **Cursor-specific exec-channel tool bridging** (`CursorExecHandlers`,
   `bridgeToolMap`) is omp/Cursor-specific plumbing with no pi analog and is
   not ported.
6. **Subagent-process gating** (`main:`/`subagents:` top-level fields in
   `WATCHDOG.yml`, `PI_ADVISOR_SUBAGENTS` env override, `/advisor on|off`,
   `/advisor main on|off`, `/advisor subagents on|off`) has no upstream
   equivalent — omp has no notion of a separate subagent process to gate,
   it IS the whole product. This is a pi-omp-advisor-specific extension of the
   config schema (additive; every field upstream's own `WATCHDOG.yml`
   schema defines is untouched), not a fidelity deviation from the advisor
   system itself.
7. **`PRIMARY_CONTEXT_CUSTOM_TYPES`** (omp's `plan-mode-context` /
   `plan-mode-reference` verbatim-expansion allowlist) is left as an empty
   set pending confirmation of pi's own plan-mode custom message type names;
   every other custom message still renders as a one-liner, matching
   upstream's default (non-allowlisted) path.
8. **Advisor session resource isolation** (`ADVISOR_RESOURCE_ISOLATION` in
   `src/advisor/orchestrator.ts`) has no upstream analog: pi's
   `DefaultResourceLoader` defaults every `no*` discovery flag to `false`,
   and `createAgentSession` feeds `resourceLoader.getExtensions()` into the
   session it builds, so an advisor's throwaway session would otherwise boot
   the user's entire globally installed extension stack. Upstream has no
   equivalent exposure because its advisor runtime is internal to omp rather
   than built on a public session-construction API. Also why `preserveOnly`
   is armed from `ctx.mode` at orchestrator start (and for `json` as well as
   `print`) rather than only from the `input` event.

9. **Activation on config presence** (`DiscoveredAdvisors.configFound`). Upstream's
   switch is the `advisor.enabled` setting (default `false`) with the roster
   optional — an empty roster runs one implicit unnamed `default` advisor. pi has
   no settings-schema surface to register such a toggle into, so discovering a
   parseable `WATCHDOG.yml` *is* the opt-in, and a file that declares `main: true`
   with no `advisors:` now starts that same implicit default advisor instead of
   silently doing nothing. Keyed on a successful parse rather than file existence,
   so a malformed config cannot activate an advisor by accident.
10. **Primary-message provenance and presentation.** Upstream marks advisor custom
   messages with `attribution: "agent"`; its message conversion then sends custom
   messages to the model as `developer`. Pi's extension API has no attribution
   field and pi converts every custom message to provider-level `user`, dropping
   `customType`. This port keeps pi's supported custom-message channel (the same
   channel used by asynchronous pi-intercom messages) and adds primary-system
   context identifying `<advisory>` messages as AI-advisor output, not
   user-authored text. A second narrowly describes late-completion placement: a
   response triggered after a completed answer should stand alone because it may
   scroll that unread answer out of view. Neither dictates whether to accept the
   advisor's technical claim. The TUI presentation also now diverges from
   upstream's collapsing rail: it is a full-width bordered card that never hides
   notes.

## Corrections made after the initial port

Bugs in this port's own wiring, found by running it (the port was written but
never executed before this):

- **The advisor had no `advise` tool at all.** Each advisor session was built
  with `tools: [...investigative tool names]` plus `customTools: [adviseTool]`,
  on the assumption those merge. They do not: pi treats `tools` as an allowlist
  (`allowedToolNames`) and activates only registry entries named in it, custom
  tools included. `advise` was filtered out of every advisor session, so the
  advisor read the primary's transcript and could never speak — the port had
  never delivered a single advisory in any mode. Fixed by `withAdviseTool()`,
  which keeps the tool name in the allowlist alongside the investigative set.
- **Headless sessions were not drained at exit.** Upstream's `runPrintMode`
  awaits `waitForAdvisorCatchup` (10 minutes on the normal path, 30s on the
  error path) so an in-flight advisor's note still lands; this port exited as
  soon as the primary's turn resolved, tearing the advisor down mid-turn.
  Reproduced here as `drainForExit()`, awaited from `session_shutdown` for
  `print`/`json` modes only.
- **Two upstream defaults were wrong.** `advisor.syncBacklog` defaults to `off`
  upstream (never gate the primary on a lagging advisor); this port hardcoded a
  threshold of 3 with no way to disable, and additionally logged a
  `falling behind…` line to stderr — into the user's session — for a
  `waitForCatchup()` that was never actually called. `advisor.immuneTurns`
  defaults to 3 upstream; this port hardcoded 1. Both are now `WATCHDOG.yml`
  fields (`syncBacklog`, `immuneTurns`) with upstream's defaults, since pi has
  no settings-schema surface to register into.
- **No transcript renderer.** This port initially registered nothing, so pi fell
  back to generic custom-message rendering and printed the raw `<advisory …>` XML
  inline. It first ported upstream's compact severity-rail renderer, then moved to
  a deliberately clearer pi-specific presentation: a full-width bordered card,
  severity-colored frame and labels, and no collapsed/hidden notes. Implemented
  in `src/advisor/advisor-message.ts` via
  `pi.registerMessageRenderer("advisor", …)`.
- **An unresolvable explicit `model:` silently downgraded the advisor.** Upstream
  resolves an explicit `model` via `resolveModelOverride`, and on failure marks
  that advisor `no_model` and builds no runtime for it. This port logged a line
  and continued into `createAgentSession` with `model: undefined`, which means
  "session default" — handing the advisor the primary's own model and latency,
  the opposite of what pinning a fast advisor model asks for. Now skipped and
  reported as `no_model` in `/advisor status`.
- **Advisor `model:` accepts upstream's `:level` suffix, carefully.** Upstream
  documents the field as a model selector with an optional thinking-level suffix
  (`x-ai/grok-code-fast:high`). Model ids legitimately contain colons
  (OpenRouter `:free`/`:exacto`, and ids such as `glm-4.7:max` where the suffix
  collides with a level name), so resolution tries the verbatim selector first
  and only then strips a suffix that is a level pi actually knows
  (`ModelThinkingLevel`). The level is then **applied**, via
  `createAgentSession`'s `thinkingLevel` option, at both the initial build and
  the context-reset rebuild. Two wrong turns preceded this: stripping any
  trailing `:token` unconditionally (which would have mis-resolved or broken
  those ids), and then documenting the level as un-appliable on the false claim
  that pi has no per-advisor thinking override — `CreateAgentSessionOptions`
  exposes exactly that. A third: briefly special-casing `:off` as unforwardable,
  after reading `ThinkingLevel` from `@earendil-works/pi-ai` (which omits `off`)
  instead of `@earendil-works/pi-agent-core`, which is the type
  `CreateAgentSessionOptions.thinkingLevel` actually uses and does include `off`.
  All seven levels including `off` are forwarded.
- **Rejected: a `roles:` map for advisor models.** An earlier attempt added one,
  on the belief that omp configs name models by role (`model: smol`). They do
  not: upstream's `AdvisorConfig.model` is always a concrete selector, and the
  global `advisor` role applies only when `model` is *omitted*. The map was
  reverted as invented, incompatible schema. pi has no role registry, so an
  omitted `model` still means "session default"; a role-equivalent default would
  need to be an explicitly pi-omp-advisor-specific field, not a reinterpretation of
  upstream's.
- **`yaml` was an undeclared dependency.** It is not in pi's host-provided set
  (`@earendil-works/*` plus `typebox`), so a bare static import resolved only
  where it happened to be hoisted — and threw at extension load elsewhere,
  which takes down the entire pi session rather than just the advisor. Now
  declared in `dependencies` and loaded through a guarded dynamic import that
  degrades to "ignore `WATCHDOG.yml`, keep `WATCHDOG.md`".

- **Emission-guard placement.** The guard was invoked inside the orchestrator's
  `routeAdvice`, i.e. downstream of `AdviseState`. Because `AdviseState.#deliver`
  records a note's severity rank *before* calling `onAdvice`, any note the guard
  then refused was permanently marked delivered and dedupe-blocked from being
  re-raised — and a deferred-note flush pushed N notes through a budget of one,
  marking all N delivered while routing one. The guard now gates at the
  `advise` tool-call boundary (`src/advisor/advise-tool.ts`), which is what
  `emission-guard.ts`'s own docs describe as upstream's `enqueueAdvice`
  boundary, and returns the same invisible `"Recorded."` on suppression.
- **Per-update budget reset ordering.** `emissionGuard.beginUpdate()` ran
  *after* `adviseState.beginUpdate(wip)`, whose WIP→final transition
  synchronously flushes deferred notes — so the flush was judged against the
  previous update's already-spent budget. Guard resets first now.
- **Retry reopening the budget.** Both `beginUpdate` calls sat inside
  `#sendBatch`'s `attempt` closure, which runs a second time on the
  thinking-stripped retry, granting one batch two accepted notes. Now latched
  to once per batch.
