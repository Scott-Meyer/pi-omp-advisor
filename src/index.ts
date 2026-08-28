/**
 * pi-omp-advisor — a faithful port of oh-my-pi's advisor/watchdog system onto pi's
 * own Agent SDK. See ./PROVENANCE.md for exactly what is byte-identical,
 * what is ported-with-adapted-types, and what is a documented deviation.
 *
 * Auto-starts on session_start when a parseable `WATCHDOG.yml`/`.yaml` is
 * discovered (even one declaring no `advisors:`, which runs the implicit default
 * advisor), or when explicitly enabled via `/advisor on`. A `WATCHDOG.md` alone
 * does NOT activate anything — it supplies standing instructions to advisors that
 * are already running, so a project can carry attention notes without every
 * session there spawning a live model call. Unlike upstream (always-on, since it IS the product), pi-omp-advisor
 * defaults off absent any config — this extension is meant to be installed
 * globally and shouldn't silently start an extra live model call in every
 * project. This gating is the one deliberate policy deviation from
 * upstream; the advisor system itself once running is the faithful port.
 *
 * Subagent processes (pi child processes spawned by a `subagent`/`task`
 * tool for delegated work) default OFF regardless of the main session's
 * state, and independently of whether a project's `WATCHDOG.yml` roster is
 * present — watching a subagent is a separate decision from watching the
 * main session. Detection uses `PI_SUBAGENT_CHILD === "1"`, NOT the mere
 * presence of `PI_SUBAGENT_PARENT_SESSION` — some subagent orchestration
 * extensions set the latter on the root interactive session too, which
 * would misclassify it as a child.
 *
 * IMPORTANT CONTRACT: pi core does not set `PI_SUBAGENT_CHILD` at all. It is set
 * by whatever spawns the subagent — notably the `pi-subagents` package. Because
 * `configDefaultEnabled` returns on the main-session branch before consulting
 * `PI_ADVISOR_SUBAGENTS`, that override is reachable ONLY for a process already
 * marked with `PI_SUBAGENT_CHILD=1`: a custom spawner must set that marker to be
 * recognized at all, and may then also set `PI_ADVISOR_SUBAGENTS=1|0` to override
 * `subagents:` for that child. Setting `PI_ADVISOR_SUBAGENTS` alone does nothing,
 * and deliberately so — it is inherited by the main process too, where honoring
 * it would silently flip the main session's own gate.
 *
 * Three independent levers, deliberately not conflated:
 * - `/advisor on|off` — THIS process only, session-scoped, never persisted.
 *   Works identically whether this process is a main session or a
 *   subagent child; a command run inside a child overrides only that
 *   child.
 * - `/advisor subagents on|off` — changes the DEFAULT for subagent
 *   children spawned from this point on in this process tree, by setting
 *   `PI_ADVISOR_SUBAGENTS` in `process.env` (inherited by any child process
 *   subsequently spawned from here) — takes effect immediately, no disk
 *   write, lives only as long as this process tree.
 * - `/advisor main on|off` — persists the `main:` field to the nearest
 *   project `WATCHDOG.yml` immediately, so the main session's default
 *   (independent of whether an advisor roster exists — a roster can stay
 *   configured for subagent-only use while `main: false`) survives across
 *   process restarts. `/advisor config` exposes the same fields plus full
 *   roster editing.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AdvisorOrchestrator, type OrchestratorHost } from "./advisor/orchestrator.ts";
import { renderAdvisorMessage, type AdvisorMessageDetails } from "./advisor/advisor-message.ts";
import {
  discoverAdvisorConfigs,
  loadWatchdogConfigFile,
  resolveAdvisorConfigEditPath,
  saveWatchdogConfigFile,
  type AdvisorConfig,
  type AdvisorConfigScope,
  type WatchdogConfigDoc,
} from "./advisor/watchdog-config.ts";

/** True only in a pi process spawned as a subagent child — see module doc. */
function isSubagentProcess(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

const PI_ADVISOR_SUBAGENTS_ENV = "PI_ADVISOR_SUBAGENTS";

/**
 * How long a headless (print/json) session waits at shutdown for advisors to
 * finish work they already have queued. Upstream's `runPrintMode` allows 10
 * minutes on the normal path; matched here so a slow advisor's note still lands
 * rather than being discarded at exit. Advisors that cannot progress are
 * skipped immediately, so an idle or dead advisor costs nothing.
 */
const HEADLESS_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;

export default function (pi: ExtensionAPI) {
  // Advisor notes render as their own card (severity-tinted rail, badges,
  // collapse past 3 notes) instead of pi's default custom-message rendering,
  // which showed the raw `<advisory ...>` XML inline. Mirrors upstream's
  // `createAdvisorMessageCard` — see ./advisor/advisor-message.ts.
  pi.registerMessageRenderer<AdvisorMessageDetails>("advisor", (message, options, theme) =>
    renderAdvisorMessage(message.details, message.content, options, theme),
  );

  let orchestrator: AdvisorOrchestrator | undefined;
  // Explicit /advisor on|off for THIS process only. `undefined` means "no
  // explicit choice made yet" — defer to the config-derived default
  // computed in startOrchestrator. Once set, an explicit choice survives
  // subsequent startOrchestrator calls (e.g. after a config save) until
  // changed again.
  let runtimeOverride: boolean | undefined;
  let runtimeEnabled = false; // effective value, recomputed by startOrchestrator / on|off
  /** Run mode of the live session, captured at session_start for teardown decisions. */
  let lastMode: ExtensionContext["mode"] | undefined;
  let configHadRoster = false; // whether a WATCHDOG.yml/.yaml/.md advisor roster was actually found
  let lastDiscoveredMainEnabled: boolean | undefined; // last-discovered `main:` field, for the status line
  let lastDiscoveredSubagentsEnabled: boolean | undefined; // last-discovered `subagents:` field, for the status line

  function isActive(): boolean {
    return runtimeEnabled && configHadRoster && !!orchestrator && orchestrator.advisorNames.length > 0;
  }

  /** Modes with no interactive user to receive a triggered turn. */
  function isHeadlessMode(mode: ExtensionContext["mode"]): boolean {
    return mode === "print" || mode === "json";
  }

  /** Default enablement for THIS process absent an explicit /advisor on|off. */
  function configDefaultEnabled(discovered: { mainEnabled: boolean | undefined; subagentsEnabled: boolean | undefined }): boolean {
    if (!isSubagentProcess()) return discovered.mainEnabled ?? true;
    const envOverride = process.env[PI_ADVISOR_SUBAGENTS_ENV];
    if (envOverride === "1") return true;
    if (envOverride === "0") return false;
    return discovered.subagentsEnabled ?? false;
  }

  function makeHost(ctx: ExtensionContext): OrchestratorHost {
    return {
      sendCustom(content, details, opts) {
        pi.sendMessage(
          { customType: "advisor", content, display: true, details },
          opts.triggerTurn ? { deliverAs: opts.deliverAs, triggerTurn: true } : { deliverAs: opts.deliverAs },
        );
      },
      isStreaming: () => !ctx.isIdle(),
      // Best-effort: pi's extension API does not expose a distinct
      // "tearing down an aborted turn" flag; approximated by the current
      // abort signal already having fired. See PROVENANCE.md.
      isAborting: () => ctx.signal?.aborted === true,
      hasQueuedWork: () => ctx.hasPendingMessages(),
      setStatus: text => ctx.ui.setStatus("advisor", text),
    };
  }

  async function startOrchestrator(ctx: ExtensionContext, force = false): Promise<void> {
    await orchestrator?.disposeAll();
    const agentDir = getAgentDir();
    const discovered = await discoverAdvisorConfigs(ctx.cwd, agentDir);
    lastDiscoveredMainEnabled = discovered.mainEnabled;
    lastDiscoveredSubagentsEnabled = discovered.subagentsEnabled;
    // A discovered WATCHDOG.yml is itself the opt-in, even with no `advisors:`
    // entries — an empty roster runs the implicit unnamed "default" advisor,
    // matching upstream, where the roster is optional and `advisor.enabled` is
    // the switch. Without this, a file containing only `main: true` parsed fine
    // and then started nothing.
    configHadRoster = discovered.advisors.length > 0 || discovered.configFound || force;
    // Recompute the effective enablement unless the user already made an
    // explicit /advisor on|off choice for this process, which always wins.
    runtimeEnabled = runtimeOverride ?? (force || configDefaultEnabled(discovered));
    if (!configHadRoster || !runtimeEnabled) {
      orchestrator = undefined;
      return;
    }
    const modelRuntime = await ModelRuntime.create();
    orchestrator = new AdvisorOrchestrator(makeHost(ctx));
    // Armed here, not only in the `input` handler below: a headless caller must
    // never have an advisor note silently start a turn, and waiting for the
    // first `input` event leaves that unguarded from session_start until the
    // first prompt.
    orchestrator.setPreserveOnly(isHeadlessMode(ctx.mode));
    await orchestrator.start(discovered, ctx, modelRuntime, agentDir);
    ctx.ui.setStatus("advisor", `pi-omp-advisor: ${orchestrator.advisorNames.join(", ") || "default"}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    lastMode = ctx.mode;
    try {
      await startOrchestrator(ctx);
    } catch (err) {
      console.error(`[pi-omp-advisor] startOrchestrator failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
  });

  pi.on("session_shutdown", async () => {
    // Headless runs exit as soon as the primary's turn resolves, which is
    // normally before a lagging advisor has finished the batch it is holding —
    // so without draining first, print/json sessions never record any advisory
    // at all. Upstream drains explicitly in `runPrintMode`. Interactive
    // sessions are not drained: the user is quitting and should not be made to
    // wait on a watcher.
    if (orchestrator && lastMode !== undefined && isHeadlessMode(lastMode)) {
      const drained = await orchestrator.drainForExit(HEADLESS_ADVISOR_DRAIN_TIMEOUT_MS);
      if (!drained) {
        console.error(
          `[pi-omp-advisor] exited with advisor work still queued after ${Math.round(HEADLESS_ADVISOR_DRAIN_TIMEOUT_MS / 1000)}s — some advice was not delivered`,
        );
      }
    }
    await orchestrator?.disposeAll();
    orchestrator = undefined;
  });

  // Compaction/branch/tree rewrite the primary transcript's shape without
  // restarting the conversation — reset each advisor's own delta cursor
  // (upstream: `resetAllRuntimes`) but not the session-level dedupe/immune
  // state (upstream: that only resets at a true conversation boundary,
  // i.e. session_start above).
  pi.on("session_compact", async () => {
    await orchestrator?.resetRuntimesOnly();
  });
  pi.on("session_tree", async () => {
    await orchestrator?.resetRuntimesOnly();
  });

  pi.on("message_end", async (event, _ctx) => {
    if (!isActive()) return;
    orchestrator!.onMessage(event.message as AgentMessage);
  });
  pi.on("turn_start", async (_event, _ctx) => {
    if (!isActive()) return;
    orchestrator!.onTurnStart();
  });
  pi.on("turn_end", async (_event, _ctx) => {
    if (!isActive()) return;
    orchestrator!.onTurnEnd();
    // Upstream awaits advisor catch-up at the end of every primary turn
    // (`onPrimaryTurnEnd`). This is a no-op unless `syncBacklog` is set in
    // WATCHDOG.yml — upstream's default is off, so by default the primary is
    // never gated on an advisor.
    await orchestrator!.waitForCatchup();
  });
  pi.on("agent_settled", async (_event, _ctx) => {
    if (!isActive()) return;
    orchestrator!.onAgentSettled();
  });

  // Headless callers (print mode) should never have advisor notes silently
  // start a hidden primary turn — upstream's `preserveOnly` /
  // `prepareForHeadlessAdvisorDrain()`. `input`'s `streamingBehavior` also
  // gives the one signal pi exposes close to upstream's `autoResumeSuppressed`:
  // "steer" while the primary is streaming is the user deliberately
  // interrupting/redirecting a live run; the next interactive prompt sent
  // while idle is a deliberate user-driven resume that clears it. This is an
  // approximation (pi has no dedicated user-interrupt event) — see
  // PROVENANCE.md.
  pi.on("input", async (event, ctx) => {
    if (!orchestrator) return;
    orchestrator.setPreserveOnly(isHeadlessMode(ctx.mode));
    if (event.source !== "interactive") return;
    if (event.streamingBehavior === "steer") {
      orchestrator.setAutoResumeSuppressed(true);
    } else if (event.streamingBehavior === undefined) {
      orchestrator.setAutoResumeSuppressed(false);
    }
  });

  async function runConfigMenu(ctx: ExtensionCommandContext): Promise<void> {
    const scopeChoice = await ctx.ui.select("Configure pi-omp-advisor's advisors for…", [
      "This project only (WATCHDOG.yml)",
      "Every project on this machine (~/.pi/agent/WATCHDOG.yml)",
    ]);
    if (scopeChoice === undefined) return;
    const scope: AdvisorConfigScope = scopeChoice.startsWith("This project") ? "project" : "user";
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };
    const filePath = await resolveAdvisorConfigEditPath(scope, dirs);
    let doc: WatchdogConfigDoc;
    try {
      doc = await loadWatchdogConfigFile(filePath);
    } catch (err) {
      // Editing on top of a file we could not parse would save a blank config
      // over it on the first Save. Refuse instead, and say which file.
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      return;
    }

    const availableModels = ctx.modelRegistry.getAvailable();
    const NO_OVERRIDE = "(use the advisor role's default model — no override)";

    async function pickModel(current: string | undefined): Promise<string | undefined | null> {
      const labels = [NO_OVERRIDE, ...availableModels.map(m => `${m.provider}/${m.id} — ${m.name}`)];
      const choice = await ctx.ui.select(`Model (current: ${current ?? "advisor role default"})`, labels);
      if (choice === undefined) return null;
      if (choice === NO_OVERRIDE) return undefined;
      const model = availableModels[labels.indexOf(choice) - 1];
      return model ? `${model.provider}/${model.id}` : null;
    }

    async function editAdvisor(a: AdvisorConfig): Promise<"removed" | "done"> {
      while (true) {
        const options = [
          `Model: ${a.model ?? "(advisor role default)"}`,
          `Tools: ${a.tools?.join(", ") ?? "(default: read, grep, glob)"}`,
          `Instructions: ${a.instructions ? `${a.instructions.slice(0, 60)}${a.instructions.length > 60 ? "…" : ""}` : "(none)"}`,
          `Enabled: ${a.enabled !== false}`,
          "Delete this advisor",
          "Back",
        ];
        const choice = await ctx.ui.select(`Advisor: ${a.name}`, options);
        if (choice === undefined || choice === "Back") return "done";
        if (choice.startsWith("Model:")) {
          const picked = await pickModel(a.model);
          if (picked !== null) {
            if (picked === undefined) delete a.model;
            else a.model = picked;
          }
          continue;
        }
        if (choice.startsWith("Tools:")) {
          const text = await ctx.ui.input("Tools (comma-separated: read, grep, glob, ls, edit, write, bash; blank = default)", a.tools?.join(", ") ?? "");
          if (text !== undefined) {
            const parsed = text.split(",").map(t => t.trim()).filter(Boolean);
            if (parsed.length === 0) delete a.tools;
            else a.tools = parsed;
          }
          continue;
        }
        if (choice.startsWith("Instructions:")) {
          const text = await ctx.ui.input("This advisor's specialization instructions (blank = none)", a.instructions ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.instructions;
            else a.instructions = text;
          }
          continue;
        }
        if (choice.startsWith("Enabled:")) {
          a.enabled = !(a.enabled !== false);
          continue;
        }
        if (choice === "Delete this advisor") {
          const ok = await ctx.ui.confirm("Delete advisor?", `Remove '${a.name}' from WATCHDOG.yml?`);
          if (ok) return "removed";
          continue;
        }
      }
    }

    while (true) {
      const advisorLabels = doc.advisors.map(
        a => `Advisor: ${a.name} (${a.model ?? "role default"}${a.enabled === false ? ", disabled" : ""})`,
      );
      const options = [
        `Shared instructions: ${doc.instructions ? `${doc.instructions.slice(0, 40)}…` : "(none)"}`,
        `Watch the main session by default: ${doc.main === true ? "on" : doc.main === false ? "off" : "on (unset, default)"}`,
        `Watch sub-agent sessions too: ${doc.subagents === true ? "on" : doc.subagents === false ? "off" : "off (unset)"}`,
        `Pause me when an advisor falls behind: ${doc.syncBacklog === undefined ? "off (default)" : doc.syncBacklog === "off" ? "off" : `${doc.syncBacklog} batches`}`,
        `Turns where later concerns stop interrupting: ${doc.immuneTurns ?? "3 (default)"}`,
        ...advisorLabels,
        "+ Add advisor",
        "Save",
        "Discard",
      ];
      const choice = await ctx.ui.select(`WATCHDOG.yml (${scope})`, options);
      if (choice === undefined || choice === "Discard") {
        ctx.ui.notify("pi-omp-advisor config: discarded, nothing written.", "info");
        return;
      }
      if (choice === "Save") {
        try {
          await saveWatchdogConfigFile(filePath, doc);
        } catch (err) {
          ctx.ui.notify(`pi-omp-advisor config NOT saved: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        ctx.ui.notify(`pi-omp-advisor config saved to ${filePath}`, "info");
        if (runtimeEnabled) await startOrchestrator(ctx);
        else ctx.ui.notify("pi-omp-advisor is off for this session (/advisor off) — saved, but not applied until /advisor on.", "info");
        return;
      }
      if (choice.startsWith("Shared instructions:")) {
        const text = await ctx.ui.input("Shared instructions for every advisor (blank = none)", doc.instructions ?? "");
        if (text !== undefined) {
          if (text.trim() === "") delete doc.instructions;
          else doc.instructions = text;
        }
        continue;
      }
      if (choice.startsWith("Watch the main session by default:")) {
        // Unset is effectively "on" (the pre-existing default), so toggling
        // from unset flips to explicit false; toggling from false flips to
        // explicit true. Once touched it stays explicit (no way back to
        // "unset" from here — delete the file's `main:` line by hand if that's
        // truly wanted).
        doc.main = doc.main === false ? true : false;
        continue;
      }
      if (choice.startsWith("Watch sub-agent sessions too:")) {
        doc.subagents = !(doc.subagents === true);
        continue;
      }
      if (choice.startsWith("Pause me when an advisor falls behind:")) {
        // Matches upstream's `advisor.syncBacklog` values exactly. "off" means
        // the primary is never gated on a lagging advisor (upstream default).
        const picked = await ctx.ui.select(
          "Pause the main agent for up to 30s when an advisor is this many batches behind",
          ["off (never pause — default)", "1 batch", "3 batches", "5 batches"],
        );
        if (picked !== undefined) {
          if (picked.startsWith("off")) delete doc.syncBacklog;
          else doc.syncBacklog = Number.parseInt(picked, 10);
        }
        continue;
      }
      if (choice.startsWith("Turns where later concerns stop interrupting:")) {
        const text = await ctx.ui.input(
          "After an interrupt, stop later CONCERNS from interrupting for how many turns? Blockers always interrupt. (blank = 3)",
          doc.immuneTurns === undefined ? "" : String(doc.immuneTurns),
        );
        if (text !== undefined) {
          const trimmed = text.trim();
          if (trimmed === "") {
            delete doc.immuneTurns;
          } else {
            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isFinite(parsed) && parsed >= 0) doc.immuneTurns = parsed;
            else ctx.ui.notify("Not a non-negative number — unchanged.", "warning");
          }
        }
        continue;
      }
      if (choice === "+ Add advisor") {
        const name = await ctx.ui.input("Advisor name", "reviewer");
        if (name?.trim()) doc.advisors.push({ name: name.trim() });
        continue;
      }
      const idx = advisorLabels.indexOf(choice);
      if (idx >= 0) {
        const result = await editAdvisor(doc.advisors[idx]);
        if (result === "removed") doc.advisors.splice(idx, 1);
      }
    }
  }

  /**
   * Persist a boolean `main:`/`subagents:` field to the nearest project
   * `WATCHDOG.yml`, preserving everything else already in that file
   * (round-trips through the same load/save the full config menu uses).
   * Creates the file if it doesn't exist yet.
   */
  async function persistTopLevelFlag(ctx: ExtensionCommandContext, field: "main" | "subagents", value: boolean): Promise<string> {
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };
    const filePath = await resolveAdvisorConfigEditPath("project", dirs);
    // A read/parse failure throws rather than yielding an empty document, so this
    // one-field toggle can never blank out a config it failed to understand.
    const doc = await loadWatchdogConfigFile(filePath);
    doc[field] = value;
    await saveWatchdogConfigFile(filePath, doc);
    return filePath;
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const [first, second] = parts;

    if (first === "config") {
      await runConfigMenu(ctx);
      return;
    }

    // /advisor subagents on|off | /advisor on|off subagents — changes the
    // DEFAULT for subagent children spawned from here on, NOT this
    // process's own state (this process may itself be a main session, where
    // "on|off" alone already means something different).
    const subagentsArg = first === "subagents" ? second : second === "subagents" ? first : undefined;
    if (subagentsArg === "on" || subagentsArg === "off") {
      const value = subagentsArg === "on";
      process.env[PI_ADVISOR_SUBAGENTS_ENV] = value ? "1" : "0";
      ctx.ui.notify(
        `pi-omp-advisor: subagents spawned from this process tree from now on will default ${value ? "on" : "off"} (session-tree only — not written to disk; use /advisor config to persist across process trees).`,
        "info",
      );
      return;
    }

    // /advisor main on|off — persists the main-session default, independent
    // of whether an advisor roster exists.
    const mainArg = first === "main" ? second : undefined;
    if (mainArg === "on" || mainArg === "off") {
      const value = mainArg === "on";
      const filePath = await persistTopLevelFlag(ctx, "main", value);
      ctx.ui.notify(`pi-omp-advisor: main-session default set to ${value ? "on" : "off"} in ${filePath}.`, "info");
      if (runtimeOverride === undefined) await startOrchestrator(ctx);
      return;
    }

    if (first === "off") {
      runtimeOverride = false;
      runtimeEnabled = false;
      ctx.ui.setStatus("advisor", "pi-omp-advisor: off");
      ctx.ui.notify("pi-omp-advisor disabled for this session.", "info");
      return;
    }
    if (first === "on") {
      runtimeOverride = true;
      runtimeEnabled = true;
      if (!orchestrator) {
        ctx.ui.setStatus("advisor", "pi-omp-advisor: starting…");
        await startOrchestrator(ctx, /* force */ true);
      }
      ctx.ui.setStatus("advisor", `pi-omp-advisor: ${orchestrator?.advisorNames.join(", ") || "no advisors configured"}`);
      ctx.ui.notify("pi-omp-advisor enabled for this session.", "info");
      return;
    }

    const subagentNote = isSubagentProcess()
      ? ` [this is a subagent session; default absent override is ${lastDiscoveredSubagentsEnabled === true ? "on" : "off"} via WATCHDOG.yml \`subagents:\`${process.env[PI_ADVISOR_SUBAGENTS_ENV] ? ` (env override: ${process.env[PI_ADVISOR_SUBAGENTS_ENV] === "1" ? "on" : "off"})` : ""}]`
      : ` [main-session default absent override is ${lastDiscoveredMainEnabled === false ? "off" : "on"} via WATCHDOG.yml \`main:\`]`;
    // An advisor whose model failed to resolve is retained by the orchestrator as
    // `no_model` but contributes no name, so `isActive()` is false when every
    // advisor failed that way. Reporting "no roster found" there would send the
    // user hunting for a missing config file when the real problem is a model key
    // in the config they already have — so surface those first.
    const overview = orchestrator?.statusOverview() ?? [];
    const describe = (s: { name: string; status: string; backlog: number }) =>
      `${s.name}: ${s.status}${s.backlog > 0 ? ` (${s.backlog} batch(es) behind)` : ""}`;
    const unusable = overview.filter(s => s.status === "no_model");
    const state = isActive()
      ? `on — watching with: ${orchestrator!.advisorNames.join(", ")} (${overview.map(describe).join(", ")})`
      : runtimeOverride === false
        ? "off (disabled for this session via /advisor off)"
        : unusable.length > 0
          ? `off — every configured advisor failed to start: ${unusable.map(describe).join(", ")}. ` +
            `Fix the \`model:\` values in WATCHDOG.yml (use "<provider>/<id>" from a model you have credentials for), or run /advisor config.`
          : "off (no WATCHDOG.yml/.yaml roster found, or not opted in for this process type — run /advisor on, or /advisor config)";
    ctx.ui.notify(`pi-omp-advisor: ${state}${subagentNote}`, "info");
  }

  // `/advisor` matches upstream's own command name, so muscle memory transfers.
  // Registered exactly once — pi resolves commands by name, so a second
  // registration of the same name would be a self-conflict.
  pi.registerCommand("advisor", {
    description: "Control pi-omp-advisor: on | off | status | config | main on|off | subagents on|off",
    handler: handleCommand,
  });
}
