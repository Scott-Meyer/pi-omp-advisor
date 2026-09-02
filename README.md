# pi-omp-advisor

A live advisor that watches your [pi](https://github.com/earendil-works/pi)
session as it works and can send it advice mid-run.

> Not affiliated with, endorsed by, or supported by oh-my-pi / Stencil Labs, Inc.,
> or by the pi project / Earendil Works. The name states what the code is a port
> of; neither upstream project has any involvement in it. "oh-my-pi", "omp", and
> "pi" are used nominatively to identify those projects, not as marks of this one.
> Also distinct from the unrelated [`pi-advisor`](https://www.npmjs.com/package/pi-advisor)
> npm package.

This is a port of the advisor/watchdog system in
[oh-my-pi](https://github.com/can1357/oh-my-pi) onto pi's own Agent SDK —
same system prompt, same `advise` tool description, same delivery-channel
semantics, same emission guard. See `PROVENANCE.md` for exactly which files
are byte-identical copies of upstream, which are ports, and every known
deviation.

## What it does

On session start, pi-omp-advisor builds one live in-process `AgentSession` per
configured advisor, each with its own model and its own throwaway context,
and feeds it a compact digest of the primary agent's transcript — one batch
per primary turn, one line per tool call.

An advisor's only way to reach the primary agent is `advise(note, severity)`.
Alongside it, an advisor gets whatever investigative tools its config grants — by
default the read-only set `read`, `grep`, `glob` (pi's `find`) — so it can check a
claim before raising it. How a note reaches the primary depends on severity and on
what the primary is doing:

| Situation | Channel |
|---|---|
| `nit` | `aside` — batched, delivered at the next step boundary, no interruption |
| `concern` / `blocker` | `steer` — interrupts the live turn, or triggers one when idle |
| Primary already gave its final answer, nothing queued | `preserve` — visible, cancellable inbox entry; released above the next normal user prompt (`blocker` still steers) |
| Within `immuneTurns` (default 3) of a previous interrupt | concerns downgraded to `aside` (`blocker` exempt) |
| Print mode, or right after a user interrupt | `preserve` |

Two gates keep the primary's transcript clean even when an advisor model
misbehaves: a noise filter (`stop`, `done`, `lgtm`, `no issues`, …) and a
budget of one accepted note per update, both applied at the tool-call
boundary before a note can enter the delivery state machine.

Preserved notes remain in an extension-owned **Advisor inbox** instead of pi's
invisible `nextTurn` queue. A widget above the editor shows up to three queued
notes immediately. Open the inbox with `Ctrl+Shift+A` or `/advisor inbox` to
deliver or dismiss one note, or deliver/dismiss the whole queue. Notes you keep
are rendered as advisor cards above the next accepted normal user message and
included in that turn's model context. The queue is persisted as session
metadata, so it survives extension reloads.

## Install

**Running from an editable checkout** (recommended if you intend to modify it —
the checkout *is* the install, so edits are live and updates are `git pull`):

```bash
curl -fsSL https://raw.githubusercontent.com/Scott-Meyer/pi-omp-advisor/main/scripts/bootstrap-machine.sh | bash
```

That clones to `$HOME/git/pi-omp-advisor`, installs dependencies, and registers it
as a local-path package. Because pi resolves that path relative to `~/.pi/agent`,
the same settings entry works on every machine.

**Or install it as a managed pi package**, so its dependencies travel with it:

```bash
pi install npm:pi-omp-advisor
pi install git:github.com/Scott-Meyer/pi-omp-advisor@v0.2.0
```

Requires pi **0.84.2 or newer** (it uses `createAgentSession`,
`DefaultResourceLoader`, and `loadProjectContextFiles`; on an older pi a missing
export throws during extension load, which takes down the whole session) and
Node **22.19+**, matching pi itself.

or add the checkout to `packages` in `~/.pi/agent/settings.json` (paths are
resolved relative to the agent dir):

```json
{ "packages": ["../../git/pi-omp-advisor"] }
```

Then create a `WATCHDOG.yml`, or nothing runs. A discovered, parseable config
file is the opt-in; if it declares no `advisors:`, one implicit default advisor
runs on the session's own model. A `WATCHDOG.md` on its own does **not** activate
anything — it only adds instructions for advisors that are already running.

> **Do not symlink `src/` into `~/.pi/agent/extensions/`.** That directory is
> for single-file/self-contained extensions and gets no dependency
> installation. pi-omp-advisor needs the `yaml` package, which pi does **not** provide
> to extensions (pi's host-provided set is `@earendil-works/pi-ai`,
> `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`). A symlinked
> `src/` resolves `yaml` only by accident — either because the symlink target
> happens to sit next to a `node_modules/` containing it, or because some
> unrelated package hoisted it into `~/.pi/agent/npm/node_modules`. Move the
> code to a machine where neither holds and every pi session fails to start.
> Installing as a package makes pi run `npm install` for it instead.
>
> A missing `yaml` no longer throws at load: `WATCHDOG.yml`/`.yaml` are skipped
> with an actionable error and `WATCHDOG.md` still works, so a packaging
> mistake degrades pi-omp-advisor rather than bricking pi.

## Configuration

`WATCHDOG.yml` (or `.yaml`), discovered at user scope
(`~/.pi/agent/WATCHDOG.yml`), at the project root, and walking up from cwd —
including inside a `.omp/` directory. A more specific file replaces an
advisor with the same name.

```yaml
main: true         # run in normal pi sessions (default true)
subagents: false   # run inside subagent processes too (default false; see note below)

advisors:
  - name: advisor
    model: openai/gpt-5.1-codex-mini   # or provider/id:high for a thinking level
    tools: [read, grep, glob]     # default; `glob` maps to pi's `find`
    instructions: Pay extra attention to auth and data-loss risk.
    enabled: true
```

`WATCHDOG.md` files on the same search path are loaded as freeform standing
instructions shared by every advisor.

If `model` is omitted an advisor inherits the primary's model, and its
latency with it. Pick something fast — an advisor's judgment always lags the
primary by its own round-trip time.

## Commands

- `/advisor on` | `off` — enable/disable for this process (force-starts a
  default advisor if no roster is configured)
- `/advisor main on|off` — default for normal sessions
- `/advisor subagents on|off` — default inside subagent processes
  (`PI_ADVISOR_SUBAGENTS=1|0` overrides per process)

> **How subagent detection works.** pi core does not mark subagent processes.
> Both `subagents:` and `PI_ADVISOR_SUBAGENTS` apply only when the spawner sets
> `PI_SUBAGENT_CHILD=1` on the child — which the
> [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) package does. A
> custom spawner must therefore set **`PI_SUBAGENT_CHILD=1`** to be recognized at
> all, and may additionally set `PI_ADVISOR_SUBAGENTS=1|0` to override
> `subagents:` for that child. Without `PI_SUBAGENT_CHILD=1` a child is treated as
> an ordinary main session and follows `main:` — setting `PI_ADVISOR_SUBAGENTS`
> alone does nothing.
- `/advisor status` — which advisors are running, and their state
- `/advisor inbox` — inspect, deliver, or dismiss preserved advisories waiting
  for the next normal user prompt (`Ctrl+Shift+A` opens the same inbox)
- `/advisor config` — interactive editor for `WATCHDOG.yml`

## Security and privacy

Read this before enabling an advisor. An advisor is a second agent that watches
your session, so it has real data-flow and trust implications.

**Your session content is sent to the advisor's model provider**, by two separate
routes. If `model:` names a different provider than your main session, all of this
goes to a *second* vendor.

1. **The per-turn digest** (`src/advisor/session-history-format.ts`), which is
   deliberately compact rather than a transcript dump:

   | Included | Form |
   |---|---|
   | your messages | **verbatim, in full** |
   | assistant replies | verbatim |
   | assistant reasoning | verbatim, when the model exposes it |
   | tool calls | name + one primary argument, truncated to 120 chars (so file paths, commands, grep patterns, URLs) |
   | successful tool results | status and size only — `⇒ ok · 31 lines`, **no body** |
   | failed tool results | status, size, and the **first line** of the error |
   | `edit`/`write` results | the **full unified diff**, fenced (`expandEditDiffs`) |
   | your `!` bash runs | command preview + exit status + line count, no output |

   So ordinary file reads and command output do **not** leave as content — but
   your own prompts do, and so does every diff the agent applies.

2. **The advisor's own tool calls.** It holds `read`/`grep`/`glob` by default and
   uses them to check claims, so it can read project files directly. Those results
   enter the advisor's context in full and go to its provider, independent of what
   the digest summarizes.

If a session must stay within one provider, set `model:` to a model from that
provider, or don't run an advisor there. To stop route 2 entirely, set
`tools: []`, which grants no investigative tools (the advisor keeps `advise`).

**Advisors can be granted write access, and are not sandboxed.** `tools:` accepts
`edit`, `write`, and `bash` in addition to the read-only default set. An advisor
is a full pi agent, so granting those gives a model that runs *automatically, with
no turn-by-turn confirmation from you*, the ability to modify files and execute
commands in your working directory. The default (`read`, `grep`, `glob`) is
read-only and is what you want unless you have a specific reason otherwise.

**The advisor reads untrusted content, and there is no output quarantine.** Error
text, edit diffs, and anything it reads with its own tools may contain text crafted
to manipulate a model. A manipulated advisor can put arbitrary text into your
primary agent's context via `advise()`.

Pi stores each note as a distinct `customType: "advisor"` message and the TUI
shows it in a full-width Advisor card. At the provider boundary, however, pi
currently converts all extension custom messages to the model's `user` role and
does not forward `customType`. The extension therefore adds primary-system
context saying that messages wrapped in `<advisory>` come from a separate AI
advisor watching the session and are not authored by the user. It also explains
one transcript behavior: if a late
advisory causes a second completion after a completed response, that newer
response may scroll the preceding one out of view and should stand on its own
without assuming the preceding response was read. Neither sentence tells the
primary whether or how to act on the advisor's technical claim.

Notes also carry `guidance="weigh, don't blindly obey"`. That wording can reduce
blind compliance, but neither it nor the visible card is a security boundary or
output quarantine. Combined with the point above, a prompt-injection payload
reaching an advisor that holds `bash` is a genuine risk. Keep advisors read-only.

**Cost and rate limits.** Each advisor is a live model session prompted roughly
once per primary turn, so it consumes tokens continuously against whatever
credentials that provider uses — a second, ongoing bill alongside your main
session, per advisor.

**Scope of what's watched.** Advisors run in main sessions by default (`main:`)
and not in subagent processes (`subagents:`). Both are configurable; see the
subagent-detection note above for the caveat about how child processes are
identified.

## Layout

- `src/index.ts` — extension wiring: config discovery, lifecycle events, the
  `pi.sendMessage` host bridge
- `src/advisor/orchestrator.ts` — one `ActiveAdvisor` per config, per-advisor
  delta cursor, batching/WIP inference, channel routing, immune-turn window
- `src/advisor/advise-logic.ts` — `AdviseState`, severity ranking,
  `resolveAdvisorDeliveryChannel`
- `src/advisor/advise-tool.ts` — the `advise` tool, with the emission guard
  gating at its boundary
- `src/advisor/emission-guard.ts` — noise filter + one-note-per-update budget
- `src/advisor/session-history-format.ts` — compact primary-transcript render
- `src/advisor/delta-render.ts` — per-source-message chunking for prompt-cache
  locality
- `src/advisor/watchdog-config.ts` — `WATCHDOG.yml`/`.md` discovery and merge
- `src/prompts/` — advisor system prompt and tool description

## License

MIT. Includes MIT-licensed material from oh-my-pi (© Mario Zechner, Can Bölük,
Stencil Labs, Inc.) — see `LICENSE` and `PROVENANCE.md` for the file-level
breakdown of what is copied, ported, and original.
