/**
 * pi-omp-advisor — a faithful port of oh-my-pi's advisor/watchdog system onto pi's
 * own Agent SDK. See ./PROVENANCE.md for exactly what is byte-identical,
 * what is ported-with-adapted-types, and what is a documented deviation.
 *
 * Auto-starts the implicit `default` advisor in every normal session. A
 * discovered `WATCHDOG.yml`/`.yaml` can customize that advisor, replace it with
 * a named roster, or set `main: false`; `/advisor on|off` changes only the live
 * session. A `WATCHDOG.md` alone supplies standing instructions to the running
 * default advisor without requiring a YAML opt-in. Like upstream, installing the
 * advisor means normal sessions are watched unless explicitly disabled.
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { formatAdvisorBatchContent, type AdvisorNote } from "./advisor/advise-logic.ts";
import { attachEnterDelivery } from "./advisor/enter-delivery.ts";
import { showAdvisorStream } from "./advisor/stream-view.ts";
import { AdvisorInbox, type QueuedAdvisorNote } from "./advisor/advisor-inbox.ts";
import { AdvisorOrchestrator, type AdvisorStatusOverviewItem, type OrchestratorHost } from "./advisor/orchestrator.ts";
import { renderAdvisorMessage, type AdvisorMessageDetails } from "./advisor/advisor-message.ts";
import { RequestedBooleanState, SerializedTransition } from "./advisor/serialized-transition.ts";
import { PrimaryStopController, formatStopReceipt } from "./advisor/primary-stop.ts";
import { PrimaryInterruptionState } from "./advisor/primary-interruption.ts";
import { formatToolCallPrimaryArg } from "./advisor/session-history-format.ts";
import { DEFAULT_ADVISOR_CONTEXT_TOKENS, MIN_ADVISOR_CONTEXT_TOKENS, type ContextWindowStatus } from "./advisor/context-window.ts";
import { FileMutationTracker } from "./advisor/file-diff.ts";
import { isOmpExtensionApi, isOmpHost, isOmpUserResumeMessage, ompAgentEndWasAborted, piHostModelRuntime } from "./advisor/host-compat.ts";
import {
  DEFAULT_FLUSH_TIMEOUT_MS,
  DEFAULT_MAX_BEHIND,
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
const ADVISOR_INBOX_WIDGET_ID = "advisor-inbox";
const ADVISOR_INBOX_SHORTCUT = "ctrl+shift+a";
const ADVISOR_PAUSE_SHORTCUT = "ctrl+shift+r";
const ADVISOR_CLEAR_SHORTCUT = "ctrl+shift+x";
const ADVISOR_INBOX_STATE_TYPE = "pi-omp-advisor-inbox";
const ADVISOR_STOP_STATE_TYPE = "pi-omp-advisor-stop";

const ADVISOR_COMMAND_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "menu", label: "menu", description: "Open the interactive advisor control menu" },
  { value: "status", label: "status", description: "Show runtime, model, backlog, and queue state" },
  { value: "inbox", label: "inbox", description: "Inspect, deliver, or dismiss queued advisories" },
  { value: "stream", label: "stream [name]", description: "Watch one advisor's own chat stream in a read-only popup" },
  { value: "queue", label: "queue", description: "Alias for the advisor inbox" },
  { value: "pause", label: "pause", description: "Pause observation and retain the queue" },
  { value: "resume", label: "resume", description: "Resume observation without releasing the queue" },
  { value: "clear", label: "clear", description: "Immediately discard every queued advisory" },
  { value: "on", label: "on", description: "Enable the advisor for this session" },
  { value: "off", label: "off", description: "Disable the advisor for this session" },
  { value: "config", label: "config", description: "Edit project or user WATCHDOG.yml settings" },
  { value: "main on", label: "main on", description: "Persistently enable normal-session observation" },
  { value: "main off", label: "main off", description: "Persistently disable normal-session observation" },
  { value: "subagents on", label: "subagents on", description: "Enable advisor defaults for new subagent processes" },
  { value: "subagents off", label: "subagents off", description: "Disable advisor defaults for new subagent processes" },
  { value: "help", label: "help", description: "Show commands, shortcuts, and delivery behavior" },
];

export function getAdvisorArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  const matches = ADVISOR_COMMAND_COMPLETIONS.filter(item => item.value.startsWith(prefix));
  return matches.length > 0 ? [...matches] : null;
}

/**
 * How long a headless (print/json) session waits at shutdown for advisors to
 * finish work they already have queued. Upstream's `runPrintMode` allows 10
 * minutes on the normal path; matched here so a slow advisor's note still lands
 * rather than being discarded at exit. Advisors that cannot progress are
 * skipped immediately, so an idle or dead advisor costs nothing.
 */
const HEADLESS_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Provenance and transcript-placement context for the primary model. Pi
 * currently converts extension custom messages to provider-level `user`
 * messages, so the model otherwise receives the `<advisory>` wrapper but not
 * its `customType: "advisor"` origin. The final sentence covers only a late
 * advisory that creates a second completion: that completion may replace the
 * preceding one as the first answer the user actually sees.
 */
const ADVISOR_PRIMARY_CONTEXT =
  "Messages wrapped in <advisory> are generated by a separate AI advisor watching this session and trying to help; they are not authored by the user. The advisor sees a condensed, potentially delayed view, so a note may concern work already addressed. Runtime stop receipts include the advisor's reason and observed cancellation events; they are not requests to resume. When an advisory arrives after a completed assistant response and causes another response, the newer response may scroll the preceding response out of view; it should stand on its own without assuming the preceding response was read.";

export default function (pi: ExtensionAPI) {
  // Advisor notes render as a full-width, non-collapsing card instead of pi's
  // default custom-message rendering, which showed the raw `<advisory ...>` XML
  // inline. See ./advisor/advisor-message.ts.
  pi.registerMessageRenderer<AdvisorMessageDetails>("advisor", (message, options, theme) =>
    renderAdvisorMessage(message.details, message.content, options, theme),
  );

  let orchestrator: AdvisorOrchestrator | undefined;
  const inbox = new AdvisorInbox();
  const primaryInterruption = new PrimaryInterruptionState();
  const fileMutationTracker = new FileMutationTracker();
  let sessionContext: ExtensionContext | undefined;
  let advisorContextNeeded = false;
  /** Our composed editor factory for Enter-to-deliver, so re-registration is idempotent. */
  let enterDeliveryEditorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  let advisorPaused = false;
  const advisorPauseRequests = new RequestedBooleanState(false);
  const advisorPauseTransitions = new SerializedTransition();
  // Model and thinking events can be emitted back-to-back (Pi's setModel
  // changes thinking before it emits model_select). Serialize both route
  // mutations so the awaited model event cannot race a fire-and-forget one.
  const inheritedRouteTransitions = new SerializedTransition();
  // Explicit /advisor on|off for THIS process only. `undefined` means "no
  // explicit choice made yet" — defer to the config-derived default
  // computed in startOrchestrator. Once set, an explicit choice survives
  // subsequent startOrchestrator calls (e.g. after a config save) until
  // changed again.
  let runtimeOverride: boolean | undefined;
  let runtimeEnabled = false; // effective value, recomputed by startOrchestrator / on|off
  /** Run mode/host of the live session, captured at session_start. */
  let lastMode: ExtensionContext["mode"] | undefined;
  let ompHost = isOmpExtensionApi(pi);
  const advisorCommandName = () => ompHost ? "/pi-advisor" : "/advisor";
  const activeThinkingLevel = (ctx: ExtensionContext) => {
    try {
      // OMP 18.2.4 exposes this on ExtensionAPI rather than ExtensionContext.
      return pi.getThinkingLevel() ?? ctx.thinkingLevel;
    } catch {
      return ctx.thinkingLevel;
    }
  };
  // Whether this process may build a configured or implicit advisor roster.
  // Normal sessions have an implicit default even when no config file exists;
  // subagent sessions remain off unless explicitly enabled.
  let advisorRosterAvailable = false;
  let lastDiscoveredMainEnabled: boolean | undefined; // last-discovered `main:` field, for the status line
  let lastDiscoveredSubagentsEnabled: boolean | undefined; // last-discovered `subagents:` field, for the status line
  // Derived from configuration, not the momentarily live child list, so route
  // events remain well-defined while child state is changing.
  let inheritedRouteConfigured = true;

  function isActive(): boolean {
    return !advisorPaused && runtimeEnabled && advisorRosterAvailable && !!orchestrator && orchestrator.advisorNames.length > 0;
  }

  const primaryStop = new PrimaryStopController({
    enabled: isActive,
    isIdle: () => sessionContext?.isIdle() ?? true,
    isAborting: () => sessionContext?.signal?.aborted === true,
    recordRequest(receipt) {
      pi.appendEntry(ADVISOR_STOP_STATE_TYPE, { event: "requested", ...receipt });
      advisorContextNeeded = true;
      // A stop is not permission for an ordinary late note to restart the run.
      primaryInterruption.suppress();
      sessionContext?.ui.notify(`Advisor ${receipt.advisor ?? "default"} requests cancellation of ${receipt.target.toolName}: ${receipt.reason}`, "warning");
    },
    abort() {
      if (!sessionContext) throw new Error("No active primary session");
      sessionContext.abort();
    },
  });

  function publishStopReceipt(): void {
    const receipt = primaryStop.settled();
    if (!receipt) return;
    pi.appendEntry(ADVISOR_STOP_STATE_TYPE, { event: "settled", ...receipt });
    const notes: AdvisorNote[] = [{ note: formatStopReceipt(receipt), advisor: receipt.advisor, severity: "blocker" }];
    advisorContextNeeded = true;
    // The run has settled: append the receipt without inserting a message
    // between a live tool call and its result, and without restarting the model.
    pi.sendMessage({ customType: "advisor", content: formatAdvisorBatchContent(notes), display: true, details: { notes, stopReceipt: receipt } }, { triggerTurn: false });
  }

  function persistInbox(): void {
    pi.appendEntry(ADVISOR_INBOX_STATE_TYPE, {
      version: 1,
      items: inbox.items,
      paused: advisorPaused,
    });
  }

  function restoreInbox(ctx: ExtensionContext): void {
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(candidate => candidate.type === "custom" && candidate.customType === ADVISOR_INBOX_STATE_TYPE);
    const data = entry?.type === "custom" ? entry.data : undefined;
    if (!data || typeof data !== "object" || !("items" in data) || !Array.isArray(data.items)) {
      inbox.clear();
      advisorPaused = false;
      advisorPauseRequests.restore(false);
      return;
    }
    advisorPaused = "paused" in data && data.paused === true;
    advisorPauseRequests.restore(advisorPaused);
    const items = data.items.filter((item): item is QueuedAdvisorNote => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<QueuedAdvisorNote>;
      return Number.isInteger(candidate.id) && typeof candidate.note === "string";
    });
    inbox.restore(items);
  }

  function updateAdvisorStatus(ctx = sessionContext): void {
    if (!ctx?.hasUI) return;
    if (advisorPaused) {
      ctx.ui.setStatus("advisor", `pi-omp-advisor: paused${inbox.items.length > 0 ? ` · ${inbox.items.length} queued` : ""}`);
      return;
    }
    if (!runtimeEnabled) {
      ctx.ui.setStatus("advisor", "pi-omp-advisor: off");
      return;
    }
    ctx.ui.setStatus("advisor", `pi-omp-advisor: ${orchestrator?.advisorNames.join(", ") || "no advisors configured"}`);
  }

  function notePreview(item: QueuedAdvisorNote, limit = 100): string {
    const text = item.note.trim().replace(/\s+/g, " ");
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function noteLabel(item: QueuedAdvisorNote): string {
    const source = item.advisor ? `${item.advisor} · ` : "";
    const lead = item.shortTitle ? `${item.shortTitle} — ` : "";
    return `#${item.id} · ${source}${item.severity ?? "nit"} · ${lead}${notePreview(item, item.shortTitle ? 80 : 100)}`;
  }

  function updateInboxWidget(ctx = sessionContext): void {
    if (!ctx?.hasUI) return;
    const items = [...inbox.items];
    if (items.length === 0) {
      ctx.ui.setWidget(ADVISOR_INBOX_WIDGET_ID, undefined);
      return;
    }
    ctx.ui.setWidget(ADVISOR_INBOX_WIDGET_ID, (_tui, theme) => {
      const shown = items.slice(0, 3);
      const lines = [
        theme.fg("warning", theme.bold(`Advisor inbox · ${items.length} queued`)) +
          (advisorPaused ? theme.fg("error", " · PAUSED") : "") +
          theme.fg("dim", ` · ${ADVISOR_INBOX_SHORTCUT} to manage`),
        ...shown.map(item => {
          const marker = item.severity === "blocker" ? "■" : item.severity === "concern" ? "▲" : "•";
          const styledMarker =
            item.severity === "blocker"
              ? theme.fg("error", marker)
              : item.severity === "concern"
                ? theme.fg("warning", marker)
                : theme.fg("accent", marker);
          const source = item.advisor ? theme.fg("muted", `${item.advisor} · `) : "";
          const title = item.shortTitle ? `${theme.bold(item.shortTitle)} ${theme.fg("dim", "— ")}` : "";
          return `  ${styledMarker} ${source}${title}${theme.fg("dim", notePreview(item, 120))}`;
        }),
      ];
      if (items.length > shown.length) lines.push(theme.fg("dim", `  … ${items.length - shown.length} more`));
      return new Text(lines.join("\n"), 1, 0);
    });
  }

  function deliverQueuedAdvice(queued: readonly QueuedAdvisorNote[], triggerTurn: boolean): number {
    if (advisorPaused) return 0;
    const current = inbox.select(queued.map(item => item.id));
    if (current.length === 0) return 0;
    const notes: AdvisorNote[] = current.map(({ id: _id, ...note }) => note);
    pi.sendMessage(
      {
        customType: "advisor",
        content: formatAdvisorBatchContent(notes),
        display: true,
        details: { notes },
      },
      triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer", triggerTurn: false },
    );
    orchestrator?.markNotesStreamed(notes);
    inbox.dismissMany(current.map(item => item.id));
    persistInbox();
    updateInboxWidget();
    updateAdvisorStatus();
    return current.length;
  }

  function releaseInboxAheadOfPrompt(): void {
    // The input event runs before pi records/renders the submitted user
    // message. Appending without triggering therefore places these cards
    // above that message while still making them context for its turn.
    deliverQueuedAdvice([...inbox.items], false);
  }

  /**
   * Enter-to-deliver: a bare Enter on an empty editor in an idle session
   * releases whatever is waiting in the advisor inbox — the one gesture pi's
   * own pipeline can never see, because empty submits are dropped before the
   * `input` event. Interception lives on the editor's input handler: pi's TUI
   * routes a keystroke to exactly one focused component, so the editor only
   * sees keys that dialogs, model pickers, and other overlays did not claim,
   * and cannot steal an Enter from any of them. Composes with an existing
   * custom editor (ours wraps whatever `getEditorComponent` had).
   */
  async function registerEnterDelivery(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || typeof ctx.ui.setEditorComponent !== "function" || typeof ctx.ui.getEditorComponent !== "function") return;
    const existing = ctx.ui.getEditorComponent();
    if (existing === enterDeliveryEditorFactory) return;
    // OMP's legacy coding-agent shim does not expose getEditorComponent. Load
    // the Pi-only fallback only after that capability check so OMP can load the
    // rest of the extension without resolving an incompatible editor class.
    let base = existing;
    if (!base) {
      const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
      base = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
    }
    enterDeliveryEditorFactory = (tui, theme, keybindings) =>
      attachEnterDelivery(base(tui, theme, keybindings), {
        isSubmitKey: data => keybindings.matches(data, "tui.input.submit"),
        state: () => ({ idle: sessionContext?.isIdle() ?? false, paused: advisorPaused, queued: inbox.items.length }),
        deliver: () => {
          const current = sessionContext;
          const delivered = deliverQueuedAdvice([...inbox.items], true);
          if (delivered > 0) {
            current?.ui.notify(`Delivered ${delivered} queued advisor ${delivered === 1 ? "advisory" : "advisories"}.`, "info");
          }
        },
      });
    ctx.ui.setEditorComponent(enterDeliveryEditorFactory);
  }

  async function showAdvisorInbox(ctx: ExtensionContext): Promise<void> {
    while (true) {
      const items = [...inbox.items];
      if (items.length === 0) {
        ctx.ui.notify("Advisor inbox: no queued advisories.", "info");
        return;
      }
      const labels = items.map(noteLabel);
      const deliverAll = `Deliver all ${items.length} now`;
      const dismissAll = `Dismiss all ${items.length} queued advisories`;
      const close = "Close inbox";
      const choice = await ctx.ui.select("Advisor inbox — select an advisory to manage", [
        ...labels,
        deliverAll,
        dismissAll,
        close,
      ]);
      if (choice === undefined || choice === close) return;
      if (choice === deliverAll) {
        if (advisorPaused) {
          ctx.ui.notify("Advisor is paused; resume it before delivering queued notes.", "warning");
          continue;
        }
        const delivered = deliverQueuedAdvice(items, true);
        ctx.ui.notify(`Delivered ${delivered} queued advisories.`, "info");
        return;
      }
      if (choice === dismissAll) {
        if (await ctx.ui.confirm("Dismiss queued advisories?", `Discard all ${items.length} advisories before they reach the agent?`)) {
          inbox.dismissMany(items.map(item => item.id));
          persistInbox();
          updateInboxWidget(ctx);
          updateAdvisorStatus(ctx);
          ctx.ui.notify(`Dismissed ${items.length} queued advisories.`, "info");
          return;
        }
        continue;
      }
      const item = items[labels.indexOf(choice)];
      if (!item) continue;
      const source = item.advisor ? ` · ${item.advisor}` : "";
      const title = item.shortTitle ? `${item.shortTitle}\n` : "";
      const action = await ctx.ui.select(
        `Advisor #${item.id}${source} · ${item.severity ?? "nit"}\n${title}${item.note}`,
        ["Deliver now", "Dismiss", "Back"],
      );
      if (action === "Deliver now") {
        if (advisorPaused) {
          ctx.ui.notify("Advisor is paused; resume it before delivering queued notes.", "warning");
          continue;
        }
        const delivered = deliverQueuedAdvice([item], true);
        ctx.ui.notify(delivered ? `Delivered advisor note #${item.id}.` : `Advisor note #${item.id} is no longer pending.`, "info");
        continue;
      }
      if (action === "Dismiss" && (await ctx.ui.confirm("Dismiss queued advisory?", item.note))) {
        inbox.dismiss(item.id);
        persistInbox();
        updateInboxWidget(ctx);
        updateAdvisorStatus(ctx);
      }
    }
  }

  function clearAdvisorInbox(ctx: ExtensionContext): void {
    const count = inbox.items.length;
    if (count === 0) {
      ctx.ui.notify("Advisor inbox is already empty.", "info");
      return;
    }
    inbox.clear();
    persistInbox();
    updateInboxWidget(ctx);
    updateAdvisorStatus(ctx);
    ctx.ui.notify(`Cleared ${count} queued ${count === 1 ? "advisory" : "advisories"}.`, "info");
  }

  function enqueueAdvisorPaused(paused: boolean, ctx: ExtensionContext): Promise<void> {
    // Serialize shortcut/command invocations so a rapid resume cannot make the
    // host look active while the preceding pause is still aborting a turn.
    const transition = advisorPauseTransitions.run(async () => {
      if (paused === advisorPaused) {
        ctx.ui.notify(`Advisor is already ${paused ? "paused" : "running"}.`, "info");
        return;
      }
      if (paused && (!runtimeEnabled || !advisorRosterAvailable || !orchestrator)) {
        advisorPauseRequests.reject(paused);
        ctx.ui.notify(`pi-omp-advisor is not running; use ${advisorCommandName()} on before pausing it.`, "warning");
        return;
      }
      if (paused) {
        advisorPaused = true;
        advisorPauseRequests.apply(true);
      }
      await orchestrator?.setPaused(paused);
      if (!paused) {
        advisorPaused = false;
        advisorPauseRequests.apply(false);
      }
      persistInbox();
      updateInboxWidget(ctx);
      updateAdvisorStatus(ctx);
      ctx.ui.notify(
        paused
          ? `Advisor paused${inbox.items.length > 0 ? `; ${inbox.items.length} queued ${inbox.items.length === 1 ? "note" : "notes"} retained` : ""}.`
          : `Advisor resumed${inbox.items.length > 0 ? `; ${inbox.items.length} notes remain queued` : ""}.`,
        "info",
      );
    });
    return transition.catch(err => {
      advisorPauseRequests.reject(paused);
      throw err;
    });
  }

  function setAdvisorPaused(paused: boolean, ctx: ExtensionContext): Promise<void> {
    advisorPauseRequests.request(paused);
    return enqueueAdvisorPaused(paused, ctx);
  }

  function toggleAdvisorPaused(ctx: ExtensionContext): Promise<void> {
    return enqueueAdvisorPaused(advisorPauseRequests.toggleRequest(), ctx);
  }

  pi.on("before_agent_start", event => {
    if ((!isActive() && !advisorContextNeeded) || event.systemPrompt.includes(ADVISOR_PRIMARY_CONTEXT)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${ADVISOR_PRIMARY_CONTEXT}` };
  });

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
        advisorContextNeeded = true;
        pi.sendMessage(
          { customType: "advisor", content, display: true, details },
          opts.triggerTurn ? { deliverAs: opts.deliverAs, triggerTurn: true } : { deliverAs: opts.deliverAs },
        );
      },
      preserveAdvice(note) {
        advisorContextNeeded = true;
        inbox.enqueue(note);
        persistInbox();
        updateInboxWidget(ctx);
        updateAdvisorStatus(ctx);
      },
      pendingAdvice: advisor => inbox.pendingFor(advisor),
      reviseAdvice(advisor, adviceId, note, shortTitle, severity) {
        if (!inbox.revise(advisor, adviceId, note, shortTitle, severity)) return false;
        persistInbox();
        updateInboxWidget(ctx);
        return true;
      },
      withdrawAdvice(advisor, adviceId) {
        if (!inbox.withdraw(advisor, adviceId)) return false;
        persistInbox();
        updateInboxWidget(ctx);
        updateAdvisorStatus(ctx);
        return true;
      },
      currentTool: () => primaryStop.currentTool(),
      requestStop: (advisor, targetId, reason) => primaryStop.requestStop(targetId, reason, advisor),
      isStreaming: () => !ctx.isIdle(),
      // Best-effort: pi's extension API does not expose a distinct
      // "tearing down an aborted turn" flag; approximated by the current
      // abort signal already having fired. See PROVENANCE.md.
      isAborting: () => ctx.signal?.aborted === true,
      isAutoResumeSuppressed: () => primaryInterruption.autoResumeSuppressed,
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
    inheritedRouteConfigured = discovered.advisors.length === 0 ||
      discovered.advisors.some(advisor => advisor.enabled !== false && advisor.model === undefined);
    // Recompute the effective enablement unless the user already made an
    // explicit /advisor on|off choice for this process, which always wins.
    // A normal session defaults on even when discovery finds no YAML: the
    // orchestrator turns the empty roster into the implicit `default` advisor.
    runtimeEnabled = runtimeOverride ?? (force || configDefaultEnabled(discovered));
    advisorRosterAvailable = discovered.advisors.length > 0 || discovered.configFound || runtimeEnabled || force;
    if (!advisorRosterAvailable || !runtimeEnabled) {
      orchestrator = undefined;
      return;
    }
    // Preserve Pi's existing child-session runtime contract without forcing
    // OMP to resolve Pi's unsupported static ModelRuntime export.
    const piModelRuntime = isOmpHost(ctx)
      ? undefined
      : piHostModelRuntime(ctx) ?? await (await import("@earendil-works/pi-coding-agent")).ModelRuntime.create();
    orchestrator = new AdvisorOrchestrator(makeHost(ctx));
    // Armed here, not only in the `input` handler below: a headless caller must
    // never have an advisor note silently start a turn, and waiting for the
    // first `input` event leaves that unguarded from session_start until the
    // first prompt.
    orchestrator.setPreserveOnly(isHeadlessMode(ctx.mode));
    await orchestrator.start(discovered, ctx, piModelRuntime ?? ctx.modelRegistry, agentDir, piModelRuntime, activeThinkingLevel(ctx));
    if (advisorPaused) await orchestrator.setPaused(true);
    updateAdvisorStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    lastMode = ctx.mode;
    ompHost = isOmpHost(ctx);
    sessionContext = ctx;
    await registerEnterDelivery(ctx);
    primaryInterruption.reset();
    primaryStop.reset();
    restoreInbox(ctx);
    advisorContextNeeded =
      inbox.items.length > 0 ||
      ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "advisor");
    updateInboxWidget(ctx);
    try {
      await startOrchestrator(ctx);
    } catch (err) {
      console.error(`[pi-omp-advisor] startOrchestrator failed: ${err instanceof Error ? err.stack : String(err)}`);
    }
    updateAdvisorStatus(ctx);
  });

  async function followPrimaryModelSelection(ctx: ExtensionContext): Promise<void> {
    if (!runtimeEnabled || !inheritedRouteConfigured) return;
    await inheritedRouteTransitions.run(async () => {
      // Re-check inside the queue: an earlier transition or command may have
      // disabled the session or replaced every follower with pinned advisors.
      if (!runtimeEnabled || !inheritedRouteConfigured || !orchestrator) return;
      sessionContext = ctx;
      try {
        // Retarget existing unpinned children in place. Rebuilding the full
        // orchestrator would discard review state and disrupt pinned advisors.
        await orchestrator.followActiveChatModel(ctx.model, activeThinkingLevel(ctx));
      } catch (err) {
        console.error(`[pi-omp-advisor] failed to follow the active chat model: ${err instanceof Error ? err.stack : String(err)}`);
      }
      updateAdvisorStatus(ctx);
    });
  }

  pi.on("model_select", async (_event, ctx) => {
    await followPrimaryModelSelection(ctx);
  });
  pi.on("thinking_level_select", async (_event, ctx) => {
    await followPrimaryModelSelection(ctx);
  });

  pi.on("session_shutdown", async () => {
    primaryInterruption.stopWatching();
    // Headless runs exit as soon as the primary's turn resolves, which is
    // normally before a lagging advisor has finished the batch it is holding —
    // so without draining first, print/json sessions never record any advisory
    // at all. Upstream drains explicitly in `runPrintMode`. Interactive
    // sessions are not drained: the user is quitting and should not be made to
    // wait on a watcher.
    if (orchestrator && lastMode !== undefined && isHeadlessMode(lastMode)) {
      const drained = await orchestrator.drainForExit(HEADLESS_ADVISOR_DRAIN_TIMEOUT_MS, true);
      if (!drained) {
        console.error(
          `[pi-omp-advisor] exited with advisor work still queued after ${Math.round(HEADLESS_ADVISOR_DRAIN_TIMEOUT_MS / 1000)}s — some advice was not delivered`,
        );
      }
    }
    await orchestrator?.disposeAll();
    orchestrator = undefined;
    inbox.clear();
    sessionContext?.ui.setWidget(ADVISOR_INBOX_WIDGET_ID, undefined);
    sessionContext = undefined;
    ompHost = false;
    primaryStop.reset();
    advisorContextNeeded = false;
    advisorPaused = false;
    advisorPauseRequests.restore(false);
  });

  // Compaction/branch/tree rewrite the primary transcript's shape without
  // restarting the conversation — reset each advisor's own delta cursor
  // (upstream: `resetAllRuntimes`) but not the session-level dedupe/immune
  // state (upstream: that only resets at a true conversation boundary,
  // i.e. session_start above).
  pi.on("session_compact", async () => {
    await orchestrator?.resetRuntimesOnly();
  });
  pi.on("session_tree", async (_event, ctx) => {
    restoreInbox(ctx);
    advisorContextNeeded =
      inbox.items.length > 0 ||
      ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === "advisor");
    updateInboxWidget(ctx);
    await orchestrator?.resetRuntimesOnly();
    await orchestrator?.setPaused(advisorPaused);
    updateAdvisorStatus(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    // Escape aborts this supported signal. Remember it after Pi clears the
    // transient signal at settlement, so a late blocker cannot undo the stop.
    primaryInterruption.watch(ctx.signal);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    primaryStop.toolStarted({
      toolCallId: event.toolCallId, toolName: event.toolName,
      summary: formatToolCallPrimaryArg(event.toolName, event.args), startedAt: Date.now(),
    });
    if (isActive()) {
      await fileMutationTracker.onToolStart(event.toolCallId, event.toolName, event.args, ctx.cwd);
    }
  });
  pi.on("tool_execution_end", (event, ctx) => {
    primaryStop.toolEnded(event.toolCallId, event.isError, ctx.signal?.aborted === true);
    fileMutationTracker.onToolEnd(event.toolCallId, event.isError);
  });

  pi.on("message_start", async (event, ctx) => {
    if (!ompHost) return;
    // OMP's RPC controller bypasses the legacy `input` event. Canonical user
    // attribution covers both ordinary prompts and `/skill:` custom messages;
    // the steering flag excludes agent/user steering just like Pi's input path.
    const message = event.message as typeof event.message & { attribution?: string; steering?: boolean };
    if (!isOmpUserResumeMessage(message)) return;
    // OMP 18.2.4 does not emit Pi's legacy model_select event. Retarget before
    // accepting each real user submission so a just-selected model is already
    // the advisor route for the turn that follows.
    await followPrimaryModelSelection(ctx);
    primaryInterruption.resume();
    // OMP's RPC path also bypasses `input`, so release preserved notes here.
    // The user message is already starting; the queued steer is folded into
    // this run without creating a separate model turn.
    releaseInboxAheadOfPrompt();
  });

  pi.on("message_end", async (event, _ctx) => {
    let message = event.message as AgentMessage;
    // OMP's legacy ExtensionContext omits Pi's live AbortSignal. Its terminal
    // assistant message still records an explicit user/provider abort; latch
    // that even while advisor observation is paused/off, because this state is
    // primary-session-owned and must survive a later advisor resume/rebuild.
    if (ompHost && message.role === "assistant" && message.stopReason === "aborted") {
      primaryInterruption.suppress();
    }
    if (!isActive()) return;
    if (message.role === "toolResult") {
      const tr = message as ToolResultMessage;
      const diff = await fileMutationTracker.onToolResult(tr.toolCallId, tr.toolName, tr.isError);
      if (diff) {
        const details = (tr.details && typeof tr.details === "object") ? tr.details : {};
        message = { ...tr, details: { ...details, diff } } as AgentMessage;
      }
    }
    orchestrator!.onMessage(message);
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
  const onPrimarySettled = () => {
    publishStopReceipt();
    fileMutationTracker.clear();
    if (!isActive()) return;
    orchestrator!.onAgentSettled();
  };
  pi.on("agent_settled", async () => {
    // Pi's settled event is the strongest lifecycle boundary: the run and all
    // of its listeners have completed. OMP 18.2.4 does not emit this legacy
    // event, so its agent_end fallback below owns settlement there.
    if (!ompHost) onPrimarySettled();
  });
  pi.on("agent_end", async event => {
    if (!ompHost) return;
    const ompEvent = event as typeof event & { willContinue?: boolean; messages?: AgentMessage[] };
    // OMP does not emit message_end for every abort path. In particular, an
    // abort while a tool is running reports the synthetic aborted assistant
    // only in agent_end.messages; latch it before a late blocker can restart.
    if (ompAgentEndWasAborted(ompEvent.messages)) primaryInterruption.suppress();
    // OMP marks intermediate loop ends that already have an automatic retry,
    // compaction, or queued continuation. Only its terminal end substitutes
    // for Pi's stronger agent_settled event.
    if (!ompEvent.willContinue) onPrimarySettled();
  });

  // A normal interactive/RPC prompt permits future advisor-driven turns.
  // Steering keeps suppression armed; extension-generated inputs do not
  // count as a user resume. Headless callers also keep preserveOnly enabled.
  pi.on("input", async (event, ctx) => {
    // Keep preserved advisories in our cancellable inbox until a normal user
    // prompt begins. Releasing here (before pi records the submitted user
    // message) preserves the existing advisor-card-above-prompt ordering.
    if (!advisorPaused && (event.source === "interactive" || event.source === "rpc") && event.streamingBehavior === undefined) {
      releaseInboxAheadOfPrompt();
    }
    orchestrator?.setPreserveOnly(isHeadlessMode(ctx.mode));
    if (event.source !== "interactive" && event.source !== "rpc") return;
    if (event.streamingBehavior === "steer") {
      primaryInterruption.suppress();
    } else if (event.streamingBehavior === undefined) {
      primaryInterruption.resume();
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
    const NO_OVERRIDE = "(use the current Pi session model — no override)";

    async function showConfigHelp(): Promise<void> {
      await ctx.ui.select(
        [
          "WATCHDOG.yml configuration",
          "",
          "Shared instructions apply to every configured advisor.",
          "Main/subagents choose which Pi process types are watched by default.",
          "Backpressure can briefly pause the primary when an advisor falls behind; off is the normal default.",
          "Immune turns prevent repeated concerns from interrupting; blockers remain interrupting.",
          "Each advisor can choose a model, tools, context budget, specialization instructions, and whether it is enabled.",
          "The context budget covers estimated input tokens, including instructions and tools. Older history expires instead of being summarized.",
          "Primary reasoning is excluded by default; including it is independent of the advisor model's own thinking level.",
          "Changes are not written until you choose Save.",
        ].join("\n"),
        ["Back"],
      );
    }

    async function pickModel(current: string | undefined): Promise<string | undefined | null> {
      const labels = [NO_OVERRIDE, ...availableModels.map(m => `${m.provider}/${m.id} — ${m.name}`)];
      const choice = await ctx.ui.select(`Model (current: ${current ?? "current Pi session model"})`, labels);
      if (choice === undefined) return null;
      if (choice === NO_OVERRIDE) return undefined;
      const model = availableModels[labels.indexOf(choice) - 1];
      return model ? `${model.provider}/${model.id}` : null;
    }

    async function editAdvisor(a: AdvisorConfig): Promise<"removed" | "done"> {
      while (true) {
        const options = [
          `Model: ${a.model ?? "(current Pi session model)"}`,
          `Tools: ${a.tools?.join(", ") ?? "(default: read, grep, glob)"}`,
          `Context budget: ${a.contextTokens ?? DEFAULT_ADVISOR_CONTEXT_TOKENS} estimated tokens${a.contextTokens === undefined ? " (default)" : ""}`,
          `Include primary reasoning: ${a.includePrimaryThinking === true ? "yes" : "no"}`,
          `Primary turns per advisor wake: ${a.maxBehind ?? "inherit"}`,
          `Maximum wait for a partial batch: ${a.flushTimeoutMs ? `${a.flushTimeoutMs}ms` : "inherit"}`,
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
        if (choice.startsWith("Context budget:")) {
          const text = await ctx.ui.input(`Estimated input-token budget (minimum ${MIN_ADVISOR_CONTEXT_TOKENS}; blank = ${DEFAULT_ADVISOR_CONTEXT_TOKENS})`, a.contextTokens?.toString() ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.contextTokens;
            else {
              const value = Number(text);
              if (Number.isSafeInteger(value) && value >= MIN_ADVISOR_CONTEXT_TOKENS) a.contextTokens = value;
              else ctx.ui.notify(`Use an integer of at least ${MIN_ADVISOR_CONTEXT_TOKENS}. Budget unchanged.`, "warning");
            }
          }
          continue;
        }
        if (choice.startsWith("Include primary reasoning:")) {
          a.includePrimaryThinking = a.includePrimaryThinking !== true;
          continue;
        }
        if (choice.startsWith("Primary turns per advisor wake:")) {
          const text = await ctx.ui.input("Completed primary turns to accumulate per advisor wake (blank = inherit, min 1)", a.maxBehind?.toString() ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.maxBehind;
            else {
              const value = Number(text);
              if (Number.isSafeInteger(value) && value >= 1) a.maxBehind = value;
              else ctx.ui.notify("Use an integer >= 1. Unchanged.", "warning");
            }
          }
          continue;
        }
        if (choice.startsWith("Maximum wait for a partial batch:")) {
          const text = await ctx.ui.input("Maximum age of the oldest accumulated turn before an advisor wake (blank = inherit, min 100ms)", a.flushTimeoutMs?.toString() ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.flushTimeoutMs;
            else {
              const value = Number(text);
              if (Number.isSafeInteger(value) && value >= 100) a.flushTimeoutMs = value;
              else ctx.ui.notify("Use an integer >= 100. Unchanged.", "warning");
            }
          }
          continue;
        }
        if (choice.startsWith("Instructions:")) {
          const text = await ctx.ui.editor("This advisor's specialization instructions (blank = none)", a.instructions ?? "");
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
        a => `Advisor: ${a.name} (${a.model ?? "current session model"}${a.enabled === false ? ", disabled" : ""})`,
      );
      const options = [
        `Shared instructions: ${doc.instructions ? `${doc.instructions.slice(0, 40)}…` : "(none)"}`,
        `Watch the main session by default: ${doc.main === true ? "on" : doc.main === false ? "off" : "on (unset, default)"}`,
        `Watch sub-agent sessions too: ${doc.subagents === true ? "on" : doc.subagents === false ? "off" : "off (unset)"}`,
        `Backpressure: pause the primary when an advisor falls behind: ${
          doc.syncBacklog === undefined
            ? "off (default)"
            : doc.syncBacklog === "off"
            ? "off"
            : typeof doc.syncBacklog === "object"
            ? `pause at ${doc.syncBacklog.pauseAt}, resume at ${doc.syncBacklog.resumeAt}`
            : `${doc.syncBacklog} queued turns`
        }`,
        `Primary turns per advisor wake: ${doc.maxBehind ?? `${DEFAULT_MAX_BEHIND} turns (default)`}`,
        `Maximum wait for a partial batch: ${doc.flushTimeoutMs ? `${doc.flushTimeoutMs}ms` : `${DEFAULT_FLUSH_TIMEOUT_MS}ms (default)`}`,
        `Turns where later concerns stop interrupting: ${doc.immuneTurns ?? "3 (default)"}`,
        ...advisorLabels,
        "+ Add advisor",
        "Help: what these settings mean",
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
        else ctx.ui.notify(`pi-omp-advisor is off for this session (${advisorCommandName()} off) — saved, but not applied until ${advisorCommandName()} on.`, "info");
        return;
      }
      if (choice.startsWith("Shared instructions:")) {
        const text = await ctx.ui.editor("Shared instructions for every advisor (blank = none)", doc.instructions ?? "");
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
      if (choice.startsWith("Backpressure: pause the primary when an advisor falls behind:")) {
        // Matches upstream's `advisor.syncBacklog` values exactly, with support
        // for hysteresis ({ pauseAt, resumeAt }) to avoid stutter. "off" means
        // the primary is never gated on a lagging advisor (upstream default).
        const picked = await ctx.ui.select(
          "Pause the main agent for up to 30s when an advisor falls behind",
          [
            "off (never pause — default)",
            "1 queued turn",
            "3 queued turns",
            "5 queued turns",
            "Hysteresis: pause at 3, resume at 1",
            "Hysteresis: pause at 5, resume at 1",
          ],
        );
        if (picked !== undefined) {
          if (picked.startsWith("off")) {
            delete doc.syncBacklog;
          } else if (picked.includes("pause at 3, resume at 1")) {
            doc.syncBacklog = { pauseAt: 3, resumeAt: 1 };
          } else if (picked.includes("pause at 5, resume at 1")) {
            doc.syncBacklog = { pauseAt: 5, resumeAt: 1 };
          } else {
            doc.syncBacklog = Number.parseInt(picked, 10);
          }
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
      if (choice.startsWith("Primary turns per advisor wake:")) {
        const text = await ctx.ui.input(
          "Completed primary turns to accumulate per advisor wake (blank = 3, min 1)",
          doc.maxBehind === undefined ? "" : String(doc.maxBehind),
        );
        if (text !== undefined) {
          const trimmed = text.trim();
          if (trimmed === "") {
            delete doc.maxBehind;
          } else {
            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isFinite(parsed) && parsed >= 1) doc.maxBehind = parsed;
            else ctx.ui.notify("Must be an integer >= 1 — unchanged.", "warning");
          }
        }
        continue;
      }
      if (choice.startsWith("Maximum wait for a partial batch:")) {
        const text = await ctx.ui.input(
          `Maximum age of the oldest accumulated turn before an advisor wake (blank = ${DEFAULT_FLUSH_TIMEOUT_MS}ms, min 100ms)`,
          doc.flushTimeoutMs === undefined ? "" : String(doc.flushTimeoutMs),
        );
        if (text !== undefined) {
          const trimmed = text.trim();
          if (trimmed === "") {
            delete doc.flushTimeoutMs;
          } else {
            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isFinite(parsed) && parsed >= 100) doc.flushTimeoutMs = parsed;
            else ctx.ui.notify("Must be an integer >= 100 — unchanged.", "warning");
          }
        }
        continue;
      }
      if (choice === "Help: what these settings mean") {
        await showConfigHelp();
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

  async function showAdvisorHelp(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.ui.select(
      [
        "pi-omp-advisor controls",
        "",
        `${advisorCommandName()} — open the interactive control menu`,
        `${advisorCommandName()} status — show runtime, model, backlog, and queue details`,
        `${advisorCommandName()} inbox — inspect, deliver, or dismiss queued notes`,
        `${advisorCommandName()} pause | resume — stop or restart observation without releasing the queue`,
        `${advisorCommandName()} clear — immediately discard every queued note`,
        `${advisorCommandName()} on | off — enable or disable this session`,
        `${advisorCommandName()} config — edit project or user WATCHDOG.yml`,
        `${advisorCommandName()} main on|off — persist the normal-session default`,
        `${advisorCommandName()} subagents on|off — set the default for newly spawned subagents`,
        "",
        `${ADVISOR_INBOX_SHORTCUT}: inbox · ${ADVISOR_PAUSE_SHORTCUT}: pause/resume · ${ADVISOR_CLEAR_SHORTCUT}: clear queue`,
        "Use Tab to accept the highlighted command or subcommand completion.",
        "Paused notes remain visible and are neither delivered nor cleared.",
      ].join("\n"),
      ["Back"],
    );
  }

  function advisorMenuState(): string {
    const queued = `${inbox.items.length} queued`;
    if (advisorPaused) return `paused · ${queued}`;
    if (isActive()) return `running: ${orchestrator!.advisorNames.join(", ")} · ${queued}`;
    if (runtimeOverride === false || !runtimeEnabled) return `off · ${queued}`;
    return `not running · ${queued}`;
  }

  async function runAdvisorMenu(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const inboxChoice = `Inbox (${inbox.items.length} queued)`;
      const toggleChoice = advisorPaused
        ? "Resume advisor"
        : isActive()
          ? "Pause advisor"
          : "Enable or restart advisor for this session";
      const options = [
        inboxChoice,
        toggleChoice,
        ...(runtimeEnabled || advisorPaused ? ["Disable advisor for this session"] : []),
        ...(inbox.items.length > 0 ? [`Clear all ${inbox.items.length} queued advisories now`] : []),
        "Configure advisors…",
        "Status details",
        "Help & shortcuts",
        "Close",
      ];
      const choice = await ctx.ui.select(`pi-omp-advisor · ${advisorMenuState()}`, options);
      if (choice === undefined || choice === "Close") return;
      if (choice === inboxChoice) {
        await showAdvisorInbox(ctx);
        continue;
      }
      if (choice === "Pause advisor") {
        await setAdvisorPaused(true, ctx);
        continue;
      }
      if (choice === "Resume advisor") {
        await setAdvisorPaused(false, ctx);
        continue;
      }
      if (choice === "Enable or restart advisor for this session") {
        await handleCommand("on", ctx);
        continue;
      }
      if (choice === "Disable advisor for this session") {
        await handleCommand("off", ctx);
        continue;
      }
      if (choice.startsWith("Clear all ")) {
        clearAdvisorInbox(ctx);
        continue;
      }
      if (choice === "Configure advisors…") {
        await runConfigMenu(ctx);
        continue;
      }
      if (choice === "Status details") {
        await handleCommand("status", ctx);
        continue;
      }
      if (choice === "Help & shortcuts") {
        await showAdvisorHelp(ctx);
      }
    }
  }

  async function showAdvisorStreamCommand(ctx: ExtensionCommandContext, name?: string): Promise<void> {
    const snapshots = orchestrator?.transcriptSnapshot() ?? [];
    if (snapshots.length === 0) {
      ctx.ui.notify(`No running advisors to watch. ${advisorCommandName()} status shows why.`, "info");
      return;
    }
    let target = name
      ? snapshots.find(s => s.name.toLowerCase() === name)
      : snapshots.length === 1
        ? snapshots[0]
        : undefined;
    if (!target) {
      const choice = await ctx.ui.select(
        "Watch which advisor's stream?",
        [...snapshots.map(s => s.name), "Cancel"],
      );
      if (!choice || choice === "Cancel") return;
      target = snapshots.find(s => s.name === choice);
    }
    if (!target) {
      ctx.ui.notify(name ? `No running advisor named "${name}".` : "No advisor selected.", "warning");
      return;
    }
    const wanted = target.name;
    await showAdvisorStream(ctx.ui.custom, () => orchestrator?.transcriptSnapshot(wanted)[0]);
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const [first, second] = parts;

    if (first === undefined || first === "menu") {
      await runAdvisorMenu(ctx);
      return;
    }
    if (first === "help") {
      await showAdvisorHelp(ctx);
      return;
    }
    if (first === "config") {
      await runConfigMenu(ctx);
      return;
    }
    if (first === "inbox" || first === "queue") {
      await showAdvisorInbox(ctx);
      return;
    }
    if (first === "stream") {
      if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify("The advisor stream popup needs an interactive TUI session.", "warning");
        return;
      }
      await showAdvisorStreamCommand(ctx, second);
      return;
    }
    if (first === "pause") {
      await setAdvisorPaused(true, ctx);
      return;
    }
    if (first === "resume") {
      await setAdvisorPaused(false, ctx);
      return;
    }
    if (first === "clear") {
      clearAdvisorInbox(ctx);
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
        `pi-omp-advisor: subagents spawned from this process tree from now on will default ${value ? "on" : "off"} (session-tree only — not written to disk; use ${advisorCommandName()} config to persist across process trees).`,
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
      advisorPauseRequests.request(false);
      await advisorPauseTransitions.run(async () => {
        runtimeOverride = false;
        runtimeEnabled = false;
        advisorPaused = false;
        advisorPauseRequests.apply(false);
        await orchestrator?.disposeAll();
        orchestrator = undefined;
        persistInbox();
        ctx.ui.setStatus("advisor", "pi-omp-advisor: off");
        ctx.ui.notify("pi-omp-advisor disabled for this session.", "info");
      });
      return;
    }
    if (first === "on") {
      advisorPauseRequests.request(false);
      await advisorPauseTransitions.run(async () => {
        runtimeOverride = true;
        runtimeEnabled = true;
        advisorPaused = false;
        advisorPauseRequests.apply(false);
        if (!orchestrator || orchestrator.advisorNames.length === 0) {
          ctx.ui.setStatus("advisor", "pi-omp-advisor: starting…");
          await startOrchestrator(ctx, /* force */ true);
        } else {
          await orchestrator.setPaused(false);
        }
        persistInbox();
        updateInboxWidget(ctx);
        updateAdvisorStatus(ctx);
        ctx.ui.notify("pi-omp-advisor enabled for this session.", "info");
      });
      return;
    }

    if (first !== "status") {
      ctx.ui.notify(`Unknown advisor command: ${parts.join(" ")}. Use ${advisorCommandName()} to open the menu or ${advisorCommandName()} help.`, "warning");
      await showAdvisorHelp(ctx);
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
    const describe = (s: AdvisorStatusOverviewItem) =>
      `${s.name}: ${s.status}` +
      (s.backlog > 0
        ? ` · backlog: ${s.backlog} turn(s) (${s.backlogMessages} message${s.backlogMessages === 1 ? "" : "s"})`
        : " · caught up") +
      ` · pending batch: ${s.pendingTurns}/${s.wakeEveryTurns} turn(s)` +
      ` · maxWait: ${s.flushTimeoutMs}ms` +
      (s.flushOnSettled === false ? " · waits for turn batch" : "") +
      ` · wakes/requests/tools: ${s.wakes}/${s.modelRequests}/${s.toolCalls}` +
      (s.context ? `; context ~${s.context.estimatedTokens}/${s.context.limitTokens} tokens, ${s.context.retainedMessages} messages, ${s.context.resets} reset(s)${s.context.trimmed ? " (older content expired/shortened)" : ""}; primary reasoning ${s.includePrimaryThinking ? "included" : "excluded"}` : "");
    const unusable = overview.filter(s => s.status === "no_model");
    const state = advisorPaused
      ? `paused — ${inbox.items.length} queued ${inbox.items.length === 1 ? "advisory" : "advisories"} retained; no new advisor work will start`
      : isActive()
        ? `on — watching with: ${orchestrator!.advisorNames.join(", ")} (${overview.map(describe).join(", ")})`
        : runtimeOverride === false
        ? `off (disabled for this session via ${advisorCommandName()} off)`
        : unusable.length > 0
          ? `off — every configured advisor failed to start: ${unusable.map(describe).join(", ")}. ` +
            `Fix the \`model:\` values in WATCHDOG.yml (use "<provider>/<id>" from a model you have credentials for), or run ${advisorCommandName()} config.`
          : `off (disabled for this process type — run ${advisorCommandName()} on, or ${advisorCommandName()} config)`;
    ctx.ui.notify(`pi-omp-advisor: ${state}${subagentNote}`, "info");
  }

  // `/advisor` matches upstream Pi muscle memory. OMP reserves that name for
  // its native advisor even when the native runtime is disabled, so the
  // namespaced alias remains available there.
  pi.registerShortcut(ADVISOR_INBOX_SHORTCUT, {
    description: "Open the queued advisor inbox",
    handler: showAdvisorInbox,
  });
  pi.registerShortcut(ADVISOR_PAUSE_SHORTCUT, {
    description: "Pause or resume the advisor",
    handler: toggleAdvisorPaused,
  });
  pi.registerShortcut(ADVISOR_CLEAR_SHORTCUT, {
    description: "Clear every queued advisory",
    handler: clearAdvisorInbox,
  });

  pi.registerCommand(ompHost ? "pi-advisor" : "advisor", {
    description: "Open pi-omp-advisor controls, inbox, status, and configuration",
    getArgumentCompletions: getAdvisorArgumentCompletions,
    handler: handleCommand,
  });
}
