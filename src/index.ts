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
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
import { advisorCustomMessageType, isOmpExtensionApi, isOmpHost, isOmpUserResumeMessage, ompAgentEndWasAborted, piHostModelRuntime } from "./advisor/host-compat.ts";
import {
  DEFAULT_FLUSH_ON_SETTLED,
  DEFAULT_FLUSH_TIMEOUT_MS,
  DEFAULT_MAX_BEHIND,
  discoverAdvisorConfigs,
  isEnoent,
  loadWatchdogConfigFile,
  resolveAdvisorConfigEditPath,
  saveWatchdogConfigFile,
  slugifyAdvisorName,
  type AdvisorConfig,
  type AdvisorConfigScope,
  type DiscoveredAdvisors,
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
 * Extract a clean, human-readable model identifier by stripping
 * gateway or provider prefix paths (e.g. "ai-gw-openai/openai/gpt-6-astra" -> "gpt-6-astra").
 */
export function cleanModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const segments = trimmed.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : trimmed;
}

/**
 * Format the compact status footer string for ctx.ui.setStatus("advisor", ...).
 */
export function formatAdvisorStatusBar(options: {
  runtimeEnabled: boolean;
  paused: boolean;
  starting?: boolean;
  queuedCount?: number;
  advisors?: Array<{ name: string; model?: string; status?: string }>;
}): string {
  const { runtimeEnabled, paused, starting = false, queuedCount = 0, advisors = [] } = options;
  const queuedStr = queuedCount > 0 ? ` · ${queuedCount} queued` : "";

  if (!runtimeEnabled) {
    return "advisor: OFF";
  }

  if (starting) {
    return "advisor: starting…";
  }

  const unusable = advisors.filter(a => a.status === "no_model");
  if (advisors.length > 0 && unusable.length === advisors.length) {
    return "advisor: OFF (no model)";
  }

  const activeAdvisors = advisors.filter(a => a.status === "running" || a.status === "paused");
  if (activeAdvisors.length === 0) {
    return paused ? `advisor: PAUSED${queuedStr}` : "advisor: OFF";
  }

  if (paused) {
    if (activeAdvisors.length === 1) {
      const clean = cleanModelId(activeAdvisors[0]!.model) ?? "no model";
      return `advisor: ${clean} PAUSED${queuedStr}`;
    }
    return `advisors: ${activeAdvisors.length} PAUSED${queuedStr}`;
  }

  if (activeAdvisors.length === 1) {
    const item = activeAdvisors[0]!;
    const clean = cleanModelId(item.model) ?? "no model";
    const name = item.name;
    const label = (name === "default" || name === "advisor") ? clean : `${name} · ${clean}`;
    return `advisor: ${label} ON${queuedStr}`;
  }

  return `advisors: ${activeAdvisors.length} active ON${queuedStr}`;
}

/**
 * Format a human-readable summary of the current economy settings.
 */
export function formatEconomySummary(options: {
  maxBehind?: number;
  flushTimeoutMs?: number;
}): string {
  const turns = options.maxBehind ?? DEFAULT_MAX_BEHIND;
  const ms = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const timeStr = ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
  return `${turns} ${turns === 1 ? "turn" : "turns"}, ${timeStr} timeout`;
}

export type ApplyAdvisorModelResult =
  | { cancelled: true }
  | { cancelled?: false; filePath: string; doc: WatchdogConfigDoc };

/**
 * Apply a model selection to the appropriate configuration file, preserving
 * the effective advisor's identity and custom settings (tools, instructions, enabled, etc.).
 */
export async function applyAdvisorModelSelection(options: {
  cwd: string;
  agentDir: string;
  pickedModel: string | undefined;
  targetScope?: AdvisorConfigScope;
  targetAdvisorName?: string;
  effectiveAdvisor?: AdvisorConfig;
  askScope?: (choices: string[]) => Promise<string | undefined>;
}): Promise<ApplyAdvisorModelResult> {
  const dirs = { projectDir: options.cwd, agentDir: options.agentDir };
  const projectFilePath = await resolveAdvisorConfigEditPath("project", dirs);
  const userFilePath = await resolveAdvisorConfigEditPath("user", dirs);
  const hasProjectConfig = await fs.access(projectFilePath).then(() => true).catch(() => false);
  const hasUserConfig = await fs.access(userFilePath).then(() => true).catch(() => false);

  let scope: AdvisorConfigScope;
  if (options.targetScope) {
    scope = options.targetScope;
  } else if (!hasProjectConfig && hasUserConfig && options.askScope) {
    const scopeChoice = await options.askScope([
      `This project only (override in ${path.basename(projectFilePath)})`,
      `Every project on this machine (update ${path.basename(userFilePath)})`,
    ]);
    if (!scopeChoice) return { cancelled: true };
    scope = scopeChoice.startsWith("This project") ? "project" : "user";
  } else {
    scope = "project";
  }

  const filePath = scope === "user" ? userFilePath : projectFilePath;
  const doc = await loadWatchdogConfigFile(filePath);

  const isUserScope = scope === "user";
  const targetName = options.targetAdvisorName ?? (
    isUserScope
      ? (doc.advisors[0]?.name ?? "default")
      : (doc.advisors[0]?.name ?? options.effectiveAdvisor?.name ?? "default")
  );
  const targetSlug = slugifyAdvisorName(targetName);
  let targetEntry = doc.advisors.find(a => slugifyAdvisorName(a.name) === targetSlug);

  const baseline: AdvisorConfig = isUserScope
    ? (targetEntry ?? { name: targetName })
    : (targetEntry ?? options.effectiveAdvisor ?? { name: targetName });

  if (!targetEntry) {
    targetEntry = {
      name: targetName,
      ...(baseline.tools ? { tools: [...baseline.tools] } : {}),
      ...(baseline.instructions ? { instructions: baseline.instructions } : {}),
      ...(baseline.contextTokens !== undefined ? { contextTokens: baseline.contextTokens } : {}),
      ...(baseline.includePrimaryThinking !== undefined ? { includePrimaryThinking: baseline.includePrimaryThinking } : {}),
      ...(baseline.maxBehind !== undefined ? { maxBehind: baseline.maxBehind } : {}),
      ...(baseline.flushTimeoutMs !== undefined ? { flushTimeoutMs: baseline.flushTimeoutMs } : {}),
      ...(baseline.flushOnSettled !== undefined ? { flushOnSettled: baseline.flushOnSettled } : {}),
      ...(baseline.enabled !== undefined ? { enabled: baseline.enabled } : {}),
    };
    doc.advisors.push(targetEntry);
  }

  if (options.pickedModel) {
    targetEntry.model = options.pickedModel;
  } else {
    delete targetEntry.model;
  }

  await saveWatchdogConfigFile(filePath, doc);
  return { cancelled: false, filePath, doc };
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
 * its host-specific advisor `customType` origin. The final sentence covers only a late
 * advisory that creates a second completion: that completion may replace the
 * preceding one as the first answer the user actually sees.
 */
const ADVISOR_PRIMARY_CONTEXT =
  "Messages wrapped in <advisory> are generated by a separate AI advisor watching this session and trying to help; they are not authored by the user. The advisor sees a condensed, potentially delayed view, so a note may concern work already addressed. Runtime stop receipts include the advisor's reason and observed cancellation events; they are not requests to resume. When an advisory arrives after a completed assistant response and causes another response, the newer response may scroll the preceding response out of view; it should stand on its own without assuming the preceding response was read.";

export default function (pi: ExtensionAPI) {
  // OMP's native advisor owns customType "advisor" and its renderer wins the
  // registration collision even when that runtime is disabled. Keep Pi's
  // established type, but use an extension-owned type on OMP so both hosts
  // actually render this package's full card.
  const advisorMessageType = advisorCustomMessageType(pi);
  const isAdvisorMessageType = (customType: string): boolean =>
    customType === "pi-omp-advisor" || customType === "advisor"; // OMP <=0.5.2 and cross-host history
  pi.registerMessageRenderer<AdvisorMessageDetails>(advisorMessageType, (message, options, theme) =>
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
  let isStarting = false;
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
  let lastDiscoveredConfigs: DiscoveredAdvisors | undefined;
  // Derived from configuration, not the momentarily live child list, so route
  // events remain well-defined while child state is changing.
  let inheritedRouteConfigured = true;

  function getEffectiveAdvisor(name?: string): AdvisorConfig {
    const targetName = name ?? orchestrator?.advisorNames[0] ?? lastDiscoveredConfigs?.advisors[0]?.name ?? "default";
    const slug = slugifyAdvisorName(targetName);
    return lastDiscoveredConfigs?.advisors.find(a => slugifyAdvisorName(a.name) === slug) ?? { name: targetName };
  }

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
    const notes: AdvisorNote[] = [{ note: formatStopReceipt(receipt), advisor: receipt.advisor, model: receipt.model, severity: "blocker" }];
    advisorContextNeeded = true;
    // The run has settled: append the receipt without inserting a message
    // between a live tool call and its result, and without restarting the model.
    pi.sendMessage({ customType: advisorMessageType, content: formatAdvisorBatchContent(notes), display: true, details: { notes, stopReceipt: receipt } }, { triggerTurn: false });
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
    const overview = orchestrator?.statusOverview();
    const text = formatAdvisorStatusBar({
      runtimeEnabled,
      paused: advisorPaused,
      queuedCount: inbox.items.length,
      advisors: overview,
    });
    ctx.ui.setStatus("advisor", text);
  }

  function notePreview(item: QueuedAdvisorNote, limit = 100): string {
    const text = item.note.trim().replace(/\s+/g, " ");
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function noteLabel(item: QueuedAdvisorNote): string {
    const identity = [item.advisor ?? (item.model ? "default" : undefined), item.model]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const source = identity ? `${identity} · ` : "";
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
          const identity = [item.advisor ?? (item.model ? "default" : undefined), item.model]
            .filter((part): part is string => Boolean(part))
            .join(" · ");
          const source = identity ? theme.fg("muted", `${identity} · `) : "";
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
        customType: advisorMessageType,
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
          { customType: advisorMessageType, content, display: true, details },
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
      reviseAdvice(advisor, adviceId, note, shortTitle, severity, model) {
        if (!inbox.revise(advisor, adviceId, note, shortTitle, severity, model)) return false;
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
      requestStop: (advisor, targetId, reason, model) => primaryStop.requestStop(targetId, reason, advisor, model),
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
    isStarting = true;
    updateAdvisorStatus(ctx);
    try {
      await orchestrator?.disposeAll();
      const agentDir = getAgentDir();
      const discovered = await discoverAdvisorConfigs(ctx.cwd, agentDir);
      lastDiscoveredConfigs = discovered;
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
    } finally {
      isStarting = false;
      updateAdvisorStatus(ctx);
    }
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
      ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && isAdvisorMessageType(entry.customType));
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
      ctx.sessionManager.getBranch().some(entry => entry.type === "custom_message" && isAdvisorMessageType(entry.customType));
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

  async function pickAdvisorModel(
    ctx: ExtensionCommandContext,
    current: string | undefined,
  ): Promise<string | undefined | null> {
    const availableModels = ctx.modelRegistry.getAvailable();
    const NO_OVERRIDE = "(use the current Pi session model — no override)";
    const labels = [NO_OVERRIDE, ...availableModels.map(m => `${m.provider}/${m.id} — ${m.name}`)];
    const choice = await ctx.ui.select(`Model (current: ${current ? (cleanModelId(current) ?? current) : "current Pi session model"})`, labels);
    if (choice === undefined) return null;
    if (choice === NO_OVERRIDE) return undefined;
    const model = availableModels[labels.indexOf(choice) - 1];
    return model ? `${model.provider}/${model.id}` : null;
  }

  async function pickAndApplyAdvisorModel(
    ctx: ExtensionCommandContext,
    targetScope?: AdvisorConfigScope,
    targetAdvisorName?: string,
    targetCurrentModel?: string,
  ): Promise<boolean> {
    const isUserScope = targetScope === "user";
    const effective = getEffectiveAdvisor(targetAdvisorName);
    const currentModel = targetCurrentModel !== undefined ? targetCurrentModel : (isUserScope ? undefined : effective.model);
    const picked = await pickAdvisorModel(ctx, currentModel);
    if (picked === null) return false;

    try {
      const result = await applyAdvisorModelSelection({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        pickedModel: picked,
        targetScope,
        targetAdvisorName,
        effectiveAdvisor: effective,
        askScope: choices => ctx.ui.select("Save advisor model change for…", choices),
      });

      if (result.cancelled) return false;

      const clean = cleanModelId(picked);
      const appliedName = targetAdvisorName ?? effective.name;
      ctx.ui.notify(
        picked
          ? `Advisor "${appliedName}" model set to ${clean} (${picked}) in ${result.filePath}.`
          : `Advisor "${appliedName}" set to follow session model in ${result.filePath}.`,
        "info",
      );
      if (runtimeEnabled) {
        await startOrchestrator(ctx);
      } else {
        const agentDir = getAgentDir();
        lastDiscoveredConfigs = await discoverAdvisorConfigs(ctx.cwd, agentDir);
      }
      updateAdvisorStatus(ctx);
      return true;
    } catch (err) {
      ctx.ui.notify(`Failed to save model: ${err instanceof Error ? err.message : String(err)}`, "error");
      return false;
    }
  }

  async function runEconomyMenu(
    ctx: ExtensionCommandContext,
    targetScope?: AdvisorConfigScope,
  ): Promise<boolean> {
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };
    const projectFilePath = await resolveAdvisorConfigEditPath("project", dirs);
    const userFilePath = await resolveAdvisorConfigEditPath("user", dirs);
    const hasProjectConfig = await fs.access(projectFilePath).then(() => true).catch(() => false);
    const hasUserConfig = await fs.access(userFilePath).then(() => true).catch(() => false);

    let scope: AdvisorConfigScope;
    if (targetScope) {
      scope = targetScope;
    } else if (!hasProjectConfig && hasUserConfig) {
      const scopeChoice = await ctx.ui.select(
        "Configure Economy & Cadence for…",
        [
          `This project only (${path.basename(projectFilePath)})`,
          `Every project on this machine (${path.basename(userFilePath)})`,
        ],
      );
      if (!scopeChoice) return false;
      scope = scopeChoice.startsWith("This project") ? "project" : "user";
    } else {
      scope = "project";
    }

    const filePath = scope === "user" ? userFilePath : projectFilePath;
    let doc: WatchdogConfigDoc;
    try {
      doc = await loadWatchdogConfigFile(filePath);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      return false;
    }

    const effective = getEffectiveAdvisor(doc.advisors[0]?.name);
    const isUserScope = scope === "user";
    const targetName = isUserScope
      ? (doc.advisors[0]?.name ?? "default")
      : (doc.advisors[0]?.name ?? effective.name ?? "default");
    const targetSlug = slugifyAdvisorName(targetName);

    const baseline: AdvisorConfig = isUserScope
      ? (doc.advisors.find(a => slugifyAdvisorName(a.name) === targetSlug) ?? { name: targetName })
      : (
          doc.advisors.find(a => slugifyAdvisorName(a.name) === targetSlug) ??
          {
            ...effective,
            name: targetName,
            maxBehind: effective.maxBehind ?? lastDiscoveredConfigs?.maxBehind,
            flushTimeoutMs: effective.flushTimeoutMs ?? lastDiscoveredConfigs?.flushTimeoutMs,
            flushOnSettled: effective.flushOnSettled ?? lastDiscoveredConfigs?.flushOnSettled,
          }
        );

    function ensureTargetEntry(): AdvisorConfig {
      let entry = doc.advisors.find(a => slugifyAdvisorName(a.name) === targetSlug);
      if (!entry) {
        entry = {
          name: targetName,
          ...(baseline.model ? { model: baseline.model } : {}),
          ...(baseline.tools ? { tools: [...baseline.tools] } : {}),
          ...(baseline.instructions ? { instructions: baseline.instructions } : {}),
          ...(baseline.contextTokens !== undefined ? { contextTokens: baseline.contextTokens } : {}),
          ...(baseline.includePrimaryThinking !== undefined ? { includePrimaryThinking: baseline.includePrimaryThinking } : {}),
          ...(baseline.maxBehind !== undefined ? { maxBehind: baseline.maxBehind } : {}),
          ...(baseline.flushTimeoutMs !== undefined ? { flushTimeoutMs: baseline.flushTimeoutMs } : {}),
          ...(baseline.flushOnSettled !== undefined ? { flushOnSettled: baseline.flushOnSettled } : {}),
          ...(baseline.enabled !== undefined ? { enabled: baseline.enabled } : {}),
        };
        doc.advisors.push(entry);
      }
      return entry;
    }

    let dirty = false;
    while (true) {
      const targetEntry = doc.advisors.find(a => slugifyAdvisorName(a.name) === targetSlug);
      const currentMaxBehind = targetEntry?.maxBehind ?? doc.maxBehind ?? (isUserScope ? undefined : (effective.maxBehind ?? lastDiscoveredConfigs?.maxBehind)) ?? DEFAULT_MAX_BEHIND;
      const currentFlushMs = targetEntry?.flushTimeoutMs ?? doc.flushTimeoutMs ?? (isUserScope ? undefined : (effective.flushTimeoutMs ?? lastDiscoveredConfigs?.flushTimeoutMs)) ?? DEFAULT_FLUSH_TIMEOUT_MS;
      const currentFlushMin = Math.round(currentFlushMs / 60_000);
      const flushDisplay = currentFlushMin >= 1 ? `${currentFlushMin}m (${currentFlushMs}ms)` : `${currentFlushMs}ms`;
      const currentContext = targetEntry?.contextTokens ?? (isUserScope ? undefined : effective.contextTokens) ?? DEFAULT_ADVISOR_CONTEXT_TOKENS;
      const currentThinking = (targetEntry?.includePrimaryThinking ?? (isUserScope ? undefined : effective.includePrimaryThinking)) === true;
      const currentSettled = targetEntry?.flushOnSettled ?? doc.flushOnSettled ?? (isUserScope ? undefined : (effective.flushOnSettled ?? lastDiscoveredConfigs?.flushOnSettled)) ?? DEFAULT_FLUSH_ON_SETTLED;

      const options = [
        `Turn batching: ${currentMaxBehind} primary ${currentMaxBehind === 1 ? "turn" : "turns"} per wake`,
        `Long-job reaction timeout: ${flushDisplay}`,
        `Cache-friendly context budget: ${currentContext.toLocaleString()} estimated tokens`,
        `Primary reasoning: ${currentThinking ? "Included" : "Excluded (recommended — saves tokens)"}`,
        `Deliver on agent settled: ${currentSettled ? "Enabled (deliver when idle)" : "Disabled (wait for full batch)"}`,
        "Help: How economy & cadence work",
        "Save & Apply changes",
        "Back (discard unapplied changes)",
      ];

      const choice = await ctx.ui.select(`Economy & Cadence (${scope}: ${path.basename(filePath)})`, options);
      if (choice === undefined || choice.startsWith("Back")) return dirty;

      if (choice === "Save & Apply changes") {
        try {
          await saveWatchdogConfigFile(filePath, doc);
          ctx.ui.notify(`Economy settings saved to ${filePath}`, "info");
          if (runtimeEnabled) {
            await startOrchestrator(ctx);
          } else {
            const agentDir = getAgentDir();
            lastDiscoveredConfigs = await discoverAdvisorConfigs(ctx.cwd, agentDir);
          }
          updateAdvisorStatus(ctx);
          return true;
        } catch (err) {
          ctx.ui.notify(`Failed to save economy settings: ${err instanceof Error ? err.message : String(err)}`, "error");
          return dirty;
        }
      }

      if (choice === "Help: How economy & cadence work") {
        await ctx.ui.select(
          [
            "How Economy & Cadence Work",
            "",
            "• Turn batching (maxBehind):",
            "  Groups multi-step tool calls so the advisor doesn't call an LLM on every single micro-turn.",
            "  Accumulates turns before waking the advisor. 3 turns is the sweet spot for high token savings.",
            "",
            "• Long-job reaction timeout (flushTimeoutMs):",
            "  If a test run, build, or command takes a long time, the advisor wakes up mid-flight once this timer expires.",
            "  Ensures you aren't left waiting without advice just because the primary hasn't finished its turn batch.",
            "",
            "• Cache-friendly context budget (contextTokens):",
            "  The advisor context window preserves a stable history prefix so prompt caching hits turn after turn.",
            "  When the estimated budget ceiling is reached, pre-update history expires cleanly at an update boundary.",
            "",
            "• Primary reasoning (includePrimaryThinking):",
            "  Excluded by default. Passing primary thinking blocks can multiply input tokens and costs significantly.",
            "",
            "• Deliver on agent settled (flushOnSettled):",
            "  Delivers any pending partial batch as soon as the agent finishes and settles, so you get advice immediately when idle.",
          ].join("\n"),
          ["Back"],
        );
        continue;
      }

      if (choice.startsWith("Turn batching:")) {
        const picked = await ctx.ui.select(
          "Primary turns to accumulate before waking advisor (saves tokens during active tool use)",
          [
            "3 turns (recommended default — high token efficiency)",
            "1 turn (immediate review on every turn)",
            "2 turns (balanced)",
            "5 turns (ultra-economical — fewer LLM calls)",
            "Custom number of turns…",
          ],
        );
        if (picked !== undefined) {
          let newTurns: number | undefined;
          if (picked.startsWith("3 turns")) newTurns = 3;
          else if (picked.startsWith("1 turn")) newTurns = 1;
          else if (picked.startsWith("2 turns")) newTurns = 2;
          else if (picked.startsWith("5 turns")) newTurns = 5;
          else if (picked.startsWith("Custom")) {
            const text = await ctx.ui.input("Enter turn count (min 1)", currentMaxBehind.toString());
            if (text !== undefined && text.trim() !== "") {
              const parsed = Number.parseInt(text.trim(), 10);
              if (Number.isSafeInteger(parsed) && parsed >= 1) newTurns = parsed;
              else ctx.ui.notify("Turn count must be an integer >= 1.", "warning");
            }
          }
          if (newTurns !== undefined) {
            doc.maxBehind = newTurns;
            const entry = ensureTargetEntry();
            entry.maxBehind = newTurns;
            dirty = true;
          }
        }
        continue;
      }

      if (choice.startsWith("Long-job reaction timeout:")) {
        const picked = await ctx.ui.select(
          "Wake advisor mid-job if a command or run takes longer than this (prevents stalling advice)",
          [
            "4 minutes (240,000ms — recommended default)",
            "2 minutes (120,000ms — faster mid-run alerts)",
            "1 minute (60,000ms — responsive)",
            "Custom milliseconds…",
          ],
        );
        if (picked !== undefined) {
          let newTimeout: number | undefined;
          if (picked.startsWith("4 minutes")) newTimeout = 240_000;
          else if (picked.startsWith("2 minutes")) newTimeout = 120_000;
          else if (picked.startsWith("1 minute")) newTimeout = 60_000;
          else if (picked.startsWith("Custom")) {
            const text = await ctx.ui.input("Enter timeout in milliseconds (min 100ms)", currentFlushMs.toString());
            if (text !== undefined && text.trim() !== "") {
              const parsed = Number.parseInt(text.trim(), 10);
              if (Number.isSafeInteger(parsed) && parsed >= 100) newTimeout = parsed;
              else ctx.ui.notify("Timeout must be an integer >= 100ms.", "warning");
            }
          }
          if (newTimeout !== undefined) {
            doc.flushTimeoutMs = newTimeout;
            const entry = ensureTargetEntry();
            entry.flushTimeoutMs = newTimeout;
            dirty = true;
          }
        }
        continue;
      }

      if (choice.startsWith("Cache-friendly context budget:")) {
        const picked = await ctx.ui.select(
          "Advisor context ceiling (stable history prefix preserved for prompt caching; resets pre-update history at ceiling)",
          [
            "32,000 tokens (recommended default)",
            "16,000 tokens (lean memory)",
            "64,000 tokens (large context)",
            "Custom token budget…",
          ],
        );
        if (picked !== undefined) {
          let newBudget: number | undefined;
          if (picked.startsWith("32,000")) newBudget = 32_000;
          else if (picked.startsWith("16,000")) newBudget = 16_000;
          else if (picked.startsWith("64,000")) newBudget = 64_000;
          else if (picked.startsWith("Custom")) {
            const text = await ctx.ui.input(`Enter estimated input token budget (minimum ${MIN_ADVISOR_CONTEXT_TOKENS})`, currentContext.toString());
            if (text !== undefined && text.trim() !== "") {
              const parsed = Number.parseInt(text.trim(), 10);
              if (Number.isSafeInteger(parsed) && parsed >= MIN_ADVISOR_CONTEXT_TOKENS) newBudget = parsed;
              else ctx.ui.notify(`Budget must be an integer >= ${MIN_ADVISOR_CONTEXT_TOKENS}.`, "warning");
            }
          }
          if (newBudget !== undefined) {
            const entry = ensureTargetEntry();
            entry.contextTokens = newBudget;
            dirty = true;
          }
        }
        continue;
      }

      if (choice.startsWith("Primary reasoning:")) {
        const nextVal = !currentThinking;
        const entry = ensureTargetEntry();
        entry.includePrimaryThinking = nextVal;
        dirty = true;
        continue;
      }

      if (choice.startsWith("Deliver on agent settled:")) {
        const nextVal = !currentSettled;
        doc.flushOnSettled = nextVal;
        const entry = ensureTargetEntry();
        entry.flushOnSettled = nextVal;
        dirty = true;
        continue;
      }
    }
  }

  async function runInstructionsMenu(
    ctx: ExtensionCommandContext,
    targetScope: AdvisorConfigScope = "project",
  ): Promise<boolean> {
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };
    const filePath = await resolveAdvisorConfigEditPath(targetScope, dirs);
    let doc: WatchdogConfigDoc;
    try {
      doc = await loadWatchdogConfigFile(filePath);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      return false;
    }

    let dirty = false;
    const watchdogMdPath = path.join(targetScope === "user" ? dirs.agentDir : ctx.cwd, "WATCHDOG.md");
    let hasWatchdogMd = false;
    try {
      await fs.access(watchdogMdPath);
      hasWatchdogMd = true;
    } catch (err) {
      if (isEnoent(err)) {
        hasWatchdogMd = false;
      } else {
        ctx.ui.notify(`Cannot access WATCHDOG.md: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }

    while (true) {
      const sharedPreview = doc.instructions ? `${doc.instructions.slice(0, 40)}…` : "(none)";
      const attentionLabel = `${targetScope === "user" ? "User-default" : "Project"} attention in WATCHDOG.md: ${hasWatchdogMd ? "exists (click to edit)" : "(none — click to create)"}`;
      const options = [
        `Shared instructions in WATCHDOG.yml: ${sharedPreview}`,
        attentionLabel,
        "Save & Apply changes to WATCHDOG.yml",
        "Back",
      ];
      const choice = await ctx.ui.select(`${targetScope === "project" ? "Project" : "User-default"} instructions & attention · ${filePath}`, options);
      if (choice === undefined || choice === "Back") return dirty;

      if (choice.startsWith("Save & Apply")) {
        try {
          await saveWatchdogConfigFile(filePath, doc);
          ctx.ui.notify(`Instructions saved to ${filePath}`, "info");
          if (runtimeEnabled) {
            await startOrchestrator(ctx);
          } else {
            const agentDir = getAgentDir();
            lastDiscoveredConfigs = await discoverAdvisorConfigs(ctx.cwd, agentDir);
          }
          updateAdvisorStatus(ctx);
          return true;
        } catch (err) {
          ctx.ui.notify(`Failed to save instructions: ${err instanceof Error ? err.message : String(err)}`, "error");
          return dirty;
        }
      }

      if (choice.startsWith("Shared instructions in WATCHDOG.yml:")) {
        const text = await ctx.ui.editor("Shared instructions for every advisor (blank = none)", doc.instructions ?? "");
        if (text !== undefined) {
          if (text.trim() === "") delete doc.instructions;
          else doc.instructions = text;
          dirty = true;
        }
        continue;
      }

      if (choice === attentionLabel) {
        let existing = "";
        try {
          existing = await fs.readFile(watchdogMdPath, "utf8");
          hasWatchdogMd = true;
        } catch (err) {
          if (isEnoent(err)) {
            existing = "";
            hasWatchdogMd = false;
          } else {
            ctx.ui.notify(`Cannot read WATCHDOG.md: ${err instanceof Error ? err.message : String(err)}`, "error");
            continue;
          }
        }
        const text = await ctx.ui.editor(`${targetScope === "user" ? "User-default" : "Project"} attention instructions (saved directly to ${watchdogMdPath})`, existing);
        if (text !== undefined) {
          if (text.trim() === "") {
            if (hasWatchdogMd) {
              const remove = await ctx.ui.confirm("Delete WATCHDOG.md?", `The text is empty. Remove ${watchdogMdPath}?`);
              if (remove) {
                try {
                  await fs.rm(watchdogMdPath, { force: true });
                  hasWatchdogMd = false;
                  ctx.ui.notify("Removed WATCHDOG.md.", "info");
                  if (runtimeEnabled) await startOrchestrator(ctx);
                } catch (err) {
                  ctx.ui.notify(`Failed to delete WATCHDOG.md: ${String(err)}`, "error");
                }
              }
            }
          } else {
            try {
              await fs.writeFile(watchdogMdPath, text, "utf8");
              hasWatchdogMd = true;
              ctx.ui.notify(`Saved WATCHDOG.md directly to ${watchdogMdPath}.`, "info");
              if (runtimeEnabled) await startOrchestrator(ctx);
            } catch (err) {
              ctx.ui.notify(`Failed to save WATCHDOG.md: ${String(err)}`, "error");
            }
          }
        }
        continue;
      }
    }
  }

  async function runGeneralSettingsMenu(
    ctx: ExtensionCommandContext,
    targetScope: AdvisorConfigScope = "project",
  ): Promise<boolean> {
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };
    const filePath = await resolveAdvisorConfigEditPath(targetScope, dirs);
    let doc: WatchdogConfigDoc;
    try {
      doc = await loadWatchdogConfigFile(filePath);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      return false;
    }

    const inherited = targetScope === "project"
      ? await discoverAdvisorConfigs(ctx.cwd, dirs.agentDir, { excludePaths: [filePath] })
      : undefined;
    let dirty = false;
    let mainTouched = false;
    let subagentsTouched = false;
    while (true) {
      const mainValue = doc.main ?? inherited?.mainEnabled ?? true;
      const subagentsValue = doc.subagents ?? inherited?.subagentsEnabled ?? false;
      const mainSource = doc.main !== undefined ? "set here" : inherited?.mainEnabled !== undefined ? "inherited" : "built-in default";
      const subagentsSource = doc.subagents !== undefined ? "set here" : inherited?.subagentsEnabled !== undefined ? "inherited" : "built-in default";
      const options = [
        `Watch main sessions by default: ${mainValue ? "on" : "off"} (${mainSource})`,
        `Watch sub-agent sessions by default: ${subagentsValue ? "on" : "off"} (${subagentsSource})`,
        ...(doc.main !== undefined ? ["Reset main-session default to inherit"] : []),
        ...(doc.subagents !== undefined ? ["Reset sub-agent default to inherit"] : []),
        "Save & Apply changes",
        "Back",
      ];
      const choice = await ctx.ui.select(`Advisor ON/OFF defaults · ${filePath}`, options);
      if (choice === undefined || choice === "Back") return dirty;

      if (choice === "Save & Apply changes") {
        try {
          await saveWatchdogConfigFile(filePath, doc);
        } catch (err) {
          ctx.ui.notify(`Failed to save settings: ${err instanceof Error ? err.message : String(err)}`, "error");
          return dirty;
        }
        ctx.ui.notify(`Advisor ON/OFF defaults saved to ${filePath}`, "info");
        try {
          // A changed saved default replaces any temporary override for this kind of session.
          if (isSubagentProcess() ? subagentsTouched : mainTouched) runtimeOverride = undefined;
          await startOrchestrator(ctx);
          updateAdvisorStatus(ctx);
        } catch (err) {
          ctx.ui.notify(`Settings were saved, but could not apply to this session: ${err instanceof Error ? err.message : String(err)}`, "warning");
        }
        return true;
      }

      if (choice.startsWith("Watch main sessions by default:")) {
        doc.main = !mainValue;
        mainTouched = true;
        dirty = true;
        continue;
      }

      if (choice.startsWith("Watch sub-agent sessions by default:")) {
        doc.subagents = !subagentsValue;
        subagentsTouched = true;
        dirty = true;
        continue;
      }

      if (choice === "Reset main-session default to inherit") {
        delete doc.main;
        mainTouched = true;
        dirty = true;
        continue;
      }
      if (choice === "Reset sub-agent default to inherit") {
        delete doc.subagents;
        subagentsTouched = true;
        dirty = true;
        continue;
      }
    }
  }

  async function runAdvancedMenu(
    ctx: ExtensionCommandContext,
    targetScope: AdvisorConfigScope = "project",
  ): Promise<boolean> {
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };
    const filePath = await resolveAdvisorConfigEditPath(targetScope, dirs);
    let doc: WatchdogConfigDoc;
    try {
      doc = await loadWatchdogConfigFile(filePath);
    } catch (err) {
      ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      return false;
    }

    let dirty = false;

    async function editAdvisorDetails(a: AdvisorConfig): Promise<"removed" | "done"> {
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
          const picked = await pickAdvisorModel(ctx, a.model);
          if (picked !== null) {
            if (picked === undefined) delete a.model;
            else a.model = picked;
            dirty = true;
          }
          continue;
        }
        if (choice.startsWith("Tools:")) {
          const text = await ctx.ui.input("Tools (comma-separated: read, grep, glob, ls, edit, write, bash; blank = default)", a.tools?.join(", ") ?? "");
          if (text !== undefined) {
            const parsed = text.split(",").map(t => t.trim()).filter(Boolean);
            if (parsed.length === 0) delete a.tools;
            else a.tools = parsed;
            dirty = true;
          }
          continue;
        }
        if (choice.startsWith("Context budget:")) {
          const text = await ctx.ui.input(`Estimated input-token budget (minimum ${MIN_ADVISOR_CONTEXT_TOKENS}; blank = ${DEFAULT_ADVISOR_CONTEXT_TOKENS})`, a.contextTokens?.toString() ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.contextTokens;
            else {
              const value = Number(text);
              if (Number.isSafeInteger(value) && value >= MIN_ADVISOR_CONTEXT_TOKENS) {
                a.contextTokens = value;
                dirty = true;
              } else ctx.ui.notify(`Use an integer of at least ${MIN_ADVISOR_CONTEXT_TOKENS}. Budget unchanged.`, "warning");
            }
          }
          continue;
        }
        if (choice.startsWith("Include primary reasoning:")) {
          a.includePrimaryThinking = a.includePrimaryThinking !== true;
          dirty = true;
          continue;
        }
        if (choice.startsWith("Primary turns per advisor wake:")) {
          const text = await ctx.ui.input("Completed primary turns to accumulate per advisor wake (blank = inherit, min 1)", a.maxBehind?.toString() ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.maxBehind;
            else {
              const value = Number(text);
              if (Number.isSafeInteger(value) && value >= 1) {
                a.maxBehind = value;
                dirty = true;
              } else ctx.ui.notify("Use an integer >= 1. Unchanged.", "warning");
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
              if (Number.isSafeInteger(value) && value >= 100) {
                a.flushTimeoutMs = value;
                dirty = true;
              } else ctx.ui.notify("Use an integer >= 100. Unchanged.", "warning");
            }
          }
          continue;
        }
        if (choice.startsWith("Instructions:")) {
          const text = await ctx.ui.editor("This advisor's specialization instructions (blank = none)", a.instructions ?? "");
          if (text !== undefined) {
            if (text.trim() === "") delete a.instructions;
            else a.instructions = text;
            dirty = true;
          }
          continue;
        }
        if (choice.startsWith("Enabled:")) {
          a.enabled = !(a.enabled !== false);
          dirty = true;
          continue;
        }
        if (choice === "Delete this advisor") {
          const ok = await ctx.ui.confirm("Delete advisor?", `Remove '${a.name}' from WATCHDOG.yml?`);
          if (ok) {
            dirty = true;
            return "removed";
          }
          continue;
        }
      }
    }

    while (true) {
      const rosterLabel = `Multi-advisor roster (${doc.advisors.length} configured)…`;
      const backpressureLabel = `Backpressure: pause primary when advisor falls behind: ${
        doc.syncBacklog === undefined
          ? "off (default)"
          : doc.syncBacklog === "off"
          ? "off"
          : typeof doc.syncBacklog === "object"
          ? `pause at ${doc.syncBacklog.pauseAt}, resume at ${doc.syncBacklog.resumeAt}`
          : `${doc.syncBacklog} queued turns`
      }`;
      const immuneLabel = `Turns where later concerns stop interrupting: ${doc.immuneTurns ?? "3 (default)"}`;

      const options = [
        rosterLabel,
        backpressureLabel,
        immuneLabel,
        "Save & Apply changes",
        "Back",
      ];
      const choice = await ctx.ui.select(`Advanced Settings (${targetScope})`, options);
      if (choice === undefined || choice === "Back") return dirty;

      if (choice === "Save & Apply changes") {
        try {
          await saveWatchdogConfigFile(filePath, doc);
          ctx.ui.notify(`Advanced settings saved to ${filePath}`, "info");
          if (runtimeEnabled) {
            await startOrchestrator(ctx);
          } else {
            const agentDir = getAgentDir();
            lastDiscoveredConfigs = await discoverAdvisorConfigs(ctx.cwd, agentDir);
          }
          updateAdvisorStatus(ctx);
          return true;
        } catch (err) {
          ctx.ui.notify(`Failed to save advanced settings: ${err instanceof Error ? err.message : String(err)}`, "error");
          return dirty;
        }
      }

      if (choice === rosterLabel) {
        while (true) {
          const labels = doc.advisors.map(
            a => `Advisor: ${a.name} (${cleanModelId(a.model) ?? "session model"}${a.enabled === false ? ", disabled" : ""})`,
          );
          const rosterChoices = [
            ...labels,
            "+ Add specialized advisor",
            "Back",
          ];
          const sub = await ctx.ui.select(`Multi-Advisor Roster (${doc.advisors.length} advisors)`, rosterChoices);
          if (sub === undefined || sub === "Back") break;
          if (sub === "+ Add specialized advisor") {
            const name = await ctx.ui.input("New advisor name (e.g. security, performance, reviewer)", "reviewer");
            if (name?.trim()) {
              doc.advisors.push({ name: name.trim() });
              dirty = true;
            }
            continue;
          }
          const idx = labels.indexOf(sub);
          if (idx >= 0) {
            const result = await editAdvisorDetails(doc.advisors[idx]!);
            if (result === "removed") {
              doc.advisors.splice(idx, 1);
              dirty = true;
            }
          }
        }
        continue;
      }

      if (choice === backpressureLabel) {
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
          dirty = true;
        }
        continue;
      }

      if (choice === immuneLabel) {
        const text = await ctx.ui.input(
          "After an interrupt, stop later CONCERNS from interrupting for how many turns? Blockers always interrupt. (blank = 3)",
          doc.immuneTurns === undefined ? "" : String(doc.immuneTurns),
        );
        if (text !== undefined) {
          const trimmed = text.trim();
          if (trimmed === "") {
            delete doc.immuneTurns;
            dirty = true;
          } else {
            const parsed = Number.parseInt(trimmed, 10);
            if (Number.isFinite(parsed) && parsed >= 0) {
              doc.immuneTurns = parsed;
              dirty = true;
            } else ctx.ui.notify("Not a non-negative number — unchanged.", "warning");
          }
        }
        continue;
      }
    }
  }

  async function runConfigMenu(ctx: ExtensionCommandContext, selectedScope?: AdvisorConfigScope): Promise<void> {
    let scope = selectedScope;
    if (!scope) {
      const scopeChoice = await ctx.ui.select("Which settings do you want to edit?", [
        "This project only (WATCHDOG.yml)",
        "User defaults (all projects unless overridden, ~/.pi/agent/WATCHDOG.yml)",
      ]);
      if (scopeChoice === undefined) return;
      scope = scopeChoice.startsWith("This project") ? "project" : "user";
    }
    const dirs = { projectDir: ctx.cwd, agentDir: getAgentDir() };

    while (true) {
      const filePath = await resolveAdvisorConfigEditPath(scope, dirs);
      let doc: WatchdogConfigDoc;
      try {
        doc = await loadWatchdogConfigFile(filePath);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      const defaults = scope === "project" ? await discoverAdvisorConfigs(ctx.cwd, dirs.agentDir) : undefined;
      const mainEnabled = doc.main ?? defaults?.mainEnabled ?? true;
      const subagentsEnabled = doc.subagents ?? defaults?.subagentsEnabled ?? false;
      const enablementLabel = `Advisor ON/OFF ${scope === "project" ? "for this project" : "user defaults"} (main ${mainEnabled ? "ON" : "OFF"}, subagents ${subagentsEnabled ? "ON" : "OFF"})…`;
      const firstAdvisor = doc.advisors[0];
      const inherited = scope === "project" ? getEffectiveAdvisor(firstAdvisor?.name) : undefined;
      const model = firstAdvisor?.model ?? inherited?.model;
      const modelLabel = `Advisor model: ${cleanModelId(model) ?? "follows session"}${model && !firstAdvisor?.model ? " (inherited)" : ""}…`;
      const currentMax = firstAdvisor?.maxBehind ?? doc.maxBehind ?? inherited?.maxBehind ?? (scope === "project" ? lastDiscoveredConfigs?.maxBehind : undefined) ?? DEFAULT_MAX_BEHIND;
      const currentMs = firstAdvisor?.flushTimeoutMs ?? doc.flushTimeoutMs ?? inherited?.flushTimeoutMs ?? (scope === "project" ? lastDiscoveredConfigs?.flushTimeoutMs : undefined) ?? DEFAULT_FLUSH_TIMEOUT_MS;
      const timingLabel = `Timing & cost (${formatEconomySummary({ maxBehind: currentMax, flushTimeoutMs: currentMs })})…`;
      const options = [
        enablementLabel,
        modelLabel,
        timingLabel,
        "Shared instructions & attention (WATCHDOG.yml / WATCHDOG.md)…",
        `Advanced (advisors, tools, backpressure: ${doc.advisors.length} configured)…`,
        "Back to advisor controls",
      ];

      const choice = await ctx.ui.select(`${scope === "project" ? "Project settings" : "User defaults (unless project overrides)"} · ${filePath}`, options);
      if (choice === undefined || choice === "Back to advisor controls") return;

      if (choice === modelLabel) {
        await pickAndApplyAdvisorModel(ctx, scope, firstAdvisor?.name, firstAdvisor?.model);
        continue;
      }
      if (choice === timingLabel) {
        await runEconomyMenu(ctx, scope);
        continue;
      }
      if (choice.startsWith("Shared instructions")) {
        await runInstructionsMenu(ctx, scope);
        continue;
      }
      if (choice === enablementLabel) {
        await runGeneralSettingsMenu(ctx, scope);
        continue;
      }
      if (choice.startsWith("Advanced")) {
        await runAdvancedMenu(ctx, scope);
        continue;
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
        `${advisorCommandName()} — session controls plus project settings and user defaults`,
        `${advisorCommandName()} model — choose or pin the advisor model`,
        `${advisorCommandName()} economy — configure turn batching, reaction timer & token budget`,
        `${advisorCommandName()} status — show runtime, model, backlog, and queue details`,
        `${advisorCommandName()} inbox — inspect, deliver, or dismiss queued notes`,
        `${advisorCommandName()} pause | resume — stop or restart observation without releasing the queue`,
        `${advisorCommandName()} clear — immediately discard every queued note`,
        `${advisorCommandName()} on | off — enable or disable this session`,
        `${advisorCommandName()} config — save project or user-default ON/OFF and other settings`,
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
    const overview = orchestrator?.statusOverview() ?? [];
    if (advisorPaused) {
      if (overview.length === 1) {
        const clean = cleanModelId(overview[0]?.model) ?? "no model";
        return `PAUSED · ${clean} · ${queued}`;
      }
      return `PAUSED · ${queued}`;
    }
    if (isActive()) {
      if (overview.length === 1) {
        const clean = cleanModelId(overview[0]?.model) ?? "no model";
        const routeType = inheritedRouteConfigured ? "session model" : "pinned";
        return `ON · ${clean} (${routeType}) · ${queued}`;
      }
      return `ON · ${overview.length} advisors · ${queued}`;
    }
    if (runtimeOverride === false || !runtimeEnabled) return `OFF · ${queued}`;
    return `not running · ${queued}`;
  }

  async function runAdvisorMenu(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const toggleChoice = advisorPaused
        ? "Resume advisor (this session only)"
        : isActive()
          ? "Pause advisor (this session only)"
          : "Turn advisor ON now (this session only)";

      const inboxLabel = `Inbox (${inbox.items.length} queued)`;

      const options = [
        toggleChoice,
        ...(runtimeEnabled || advisorPaused ? ["Turn advisor OFF now (this session only)"] : []),
        inboxLabel,
        ...(inbox.items.length > 0 ? [`Clear all ${inbox.items.length} queued advisories now`] : []),
        "Status details",
        "Settings for this project…",
        "User defaults for all projects…",
        "Help & shortcuts",
        "Close",
      ];

      const choice = await ctx.ui.select(`pi-omp-advisor · ${advisorMenuState()}`, options);
      if (choice === undefined || choice === "Close") return;

      if (choice === toggleChoice) {
        if (advisorPaused) await setAdvisorPaused(false, ctx);
        else if (isActive()) await setAdvisorPaused(true, ctx);
        else await handleCommand("on", ctx);
        continue;
      }

      if (choice === "Turn advisor OFF now (this session only)") {
        await handleCommand("off", ctx);
        continue;
      }

      if (choice === inboxLabel) {
        await showAdvisorInbox(ctx);
        continue;
      }

      if (choice.startsWith("Clear all ")) {
        clearAdvisorInbox(ctx);
        continue;
      }

      if (choice === "Settings for this project…") {
        await runConfigMenu(ctx, "project");
        continue;
      }

      if (choice === "User defaults for all projects…") {
        await runConfigMenu(ctx, "user");
        continue;
      }

      if (choice === "Status details") {
        await handleCommand("status", ctx);
        continue;
      }

      if (choice === "Help & shortcuts") {
        await showAdvisorHelp(ctx);
        continue;
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
      const labels = snapshots.map(snapshot => `${snapshot.name}${snapshot.model ? ` · ${snapshot.model}` : ""}`);
      const choice = await ctx.ui.select(
        "Watch which advisor's stream?",
        [...labels, "Cancel"],
      );
      if (!choice || choice === "Cancel") return;
      target = snapshots[labels.indexOf(choice)];
    }
    if (!target) {
      ctx.ui.notify(name ? `No running advisor named "${name}".` : "No advisor selected.", "warning");
      return;
    }
    const wanted = target.name;
    await showAdvisorStream(ctx.ui.custom, () => orchestrator?.transcriptSnapshot(wanted)[0]);
  }

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const agentDir = getAgentDir();
    if (!lastDiscoveredConfigs) {
      lastDiscoveredConfigs = await discoverAdvisorConfigs(ctx.cwd, agentDir);
    }

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
    if (first === "model") {
      await pickAndApplyAdvisorModel(ctx);
      return;
    }
    if (first === "economy") {
      await runEconomyMenu(ctx);
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
        ctx.ui.setStatus("advisor", formatAdvisorStatusBar({ runtimeEnabled: false, paused: false }));
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
          ctx.ui.setStatus("advisor", formatAdvisorStatusBar({ runtimeEnabled: true, paused: false, starting: true }));
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
      ? ` [subagent default is ${lastDiscoveredSubagentsEnabled === true ? "on" : "off"}; override with WATCHDOG.yml \`subagents:\`${process.env[PI_ADVISOR_SUBAGENTS_ENV] ? ` (env override: ${process.env[PI_ADVISOR_SUBAGENTS_ENV] === "1" ? "on" : "off"})` : ""}]`
      : ` [main-session default is ${lastDiscoveredMainEnabled === false ? "off" : "on"}; override with WATCHDOG.yml \`main:\`]`;
    // An advisor whose model failed to resolve is retained by the orchestrator as
    // `no_model` but contributes no name, so `isActive()` is false when every
    // advisor failed that way. Reporting "no roster found" there would send the
    // user hunting for a missing config file when the real problem is a model key
    // in the config they already have — so surface those first.
    const overview = orchestrator?.statusOverview() ?? [];
    const describe = (s: AdvisorStatusOverviewItem) =>
      `${s.name}${s.model ? ` · ${s.model}` : " · no model"}: ${s.status}` +
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
        ? `on — watching with: ${orchestrator!.advisorLabels.join(", ")} (${overview.map(describe).join(", ")})`
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
