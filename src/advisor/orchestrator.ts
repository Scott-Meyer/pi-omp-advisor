/**
 * Host orchestrator — the pi-side equivalent of oh-my-pi's
 * `src/session/session-advisors.ts` (`SessionAdvisors`, npm
 * `@oh-my-pi/pi-coding-agent@17.4.1`). Owns one `ActiveAdvisor` per
 * configured advisor, feeds each its own delta cursor over the primary's
 * transcript, and implements the delivery-channel routing, immune-turn
 * window, and reset points documented in ../../PROVENANCE.md (this file is
 * a genuine reimplementation against pi's SDK, not a line-for-line port —
 * upstream's version wires into omp-internal session/telemetry/session-store
 * plumbing that has no pi equivalent; see PROVENANCE.md items 4-5).
 *
 * Batching/cadence: completed primary turns accumulate into one observation.
 * A continuing run wakes the advisor after `maxBehind` turns, while
 * `flushTimeoutMs` bounds how long the oldest unseen message may wait. Short
 * settled runs keep accumulating across prompts; settlement flushes only when
 * the turn threshold is reached. Activity that arrives while the advisor is
 * reviewing is folded into one catch-up observation.
 * Tool lifecycle events never wake the model; the primary-stop controller
 * tracks them independently and a live snapshot is attached to a normally
 * scheduled review when that capability is granted.
 */
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
// `ThinkingLevel` must come from pi-agent-core, which is what
// `CreateAgentSessionOptions.thinkingLevel` is typed against (`sdk.d.ts:1`).
// pi-ai exports a NARROWER type of the same name that omits "off", so importing
// from there makes a perfectly forwardable `:off` suffix look unrepresentable.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  ADVISOR_DEFAULT_TOOL_NAMES,
  formatAdvisorBatchContent,
  isAdvisorInterruptImmuneTurnActive,
  isInterruptingSeverity,
  resolveAdvisorDeliveryChannel,
  resolveAdvisorToolName,
  type AdvisorNote,
  type PendingAdvisorNote,
  type PendingAdviceAccess,
  type AdvisorSeverity,
} from "./advise-logic.ts";
import { ADVISOR_COMMUNICATION_TOOLS, makeAdviseTool } from "./advise-tool.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";
import { renderAdvisorDeltaMessages } from "./delta-render.ts";
import { SerializedTransition } from "./serialized-transition.ts";
import { installAdvisorContextWindow, type ContextWindowStatus } from "./context-window.ts";
import { ADVISOR_STOP_TOOLS } from "./stop-tools.ts";
import type { CurrentToolResult, PrimaryStopAccess, StopRequestResult } from "./primary-stop.ts";
import type { AdvisorConfig, SyncBacklogConfig } from "./watchdog-config.ts";
import { DEFAULT_FLUSH_ON_SETTLED, DEFAULT_FLUSH_TIMEOUT_MS, DEFAULT_MAX_BEHIND, discoverWatchdogFiles, normalizeSyncBacklog } from "./watchdog-config.ts";
import { buildAdvisorSystemPrompt } from "./system-prompt.ts";
import {
  advisorSessionToolOptions,
  disableNestedHostAdvisor,
  findAdvisorModel,
  isOmpHost,
  loadAdvisorContextFiles,
  type AdvisorModel,
  type AdvisorModelRegistry,
} from "./host-compat.ts";

/**
 * An advisor's session is a throwaway watcher, not a second user session: it
 * gets a fixed system prompt (built by buildAdvisorSystemPrompt, which already
 * embeds the context files it should see) and a fixed tool list. Without this,
 * `DefaultResourceLoader` defaults every `no*` flag to `false` and
 * `createAgentSession` feeds `resourceLoader.getExtensions()` into the new
 * session — so every advisor would boot the user's entire globally installed
 * extension stack (MCP servers, IPC sockets, telemetry timers, and
 * pi-omp-advisor itself) inside a context that has no use for any of it.
 */
const ADVISOR_RESOURCE_ISOLATION = {
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

/** Upstream `advisor.immuneTurns` default (settings-schema.ts). */
const ADVISOR_IMMUNE_TURNS_DEFAULT = 3;

/**
 * `PI_ADVISOR_DEBUG=1` traces advisor decisions to stderr. An advisor's own
 * session is in-memory and never rendered, so its tool calls are invisible:
 * without this there is no way to tell "the advisor said nothing" apart from
 * "the advisor spoke and the note was suppressed or routed somewhere
 * invisible". Off by default — routine advisor state must never be narrated
 * into a user's session.
 */
const DEBUG = process.env.PI_ADVISOR_DEBUG === "1";

/**
 * Thinking levels pi recognizes (`ModelThinkingLevel` in `@earendil-works/pi-ai`
 * — `off` plus `ThinkingLevel`). Used only to decide whether a trailing
 * `:suffix` on an advisor `model:` selector may be a thinking level, and only
 * after the verbatim selector has already failed to resolve.
 */
const ADVISOR_THINKING_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * `createAgentSession`'s `tools` option is an ALLOWLIST, not an "additionally
 * enable these" list: pi sets `allowedToolNames` from it and then activates only
 * registry entries whose name is in that set — custom tools included (see
 * `agent-session.js`, `isAllowedTool` / the `allowedToolNames` branch of
 * `nextActiveToolNames`). Passing only the investigative tools therefore
 * filtered `advise` straight out of the advisor's toolset, leaving it able to
 * read the primary's transcript and physically unable to say anything about it.
 * The communication tools (advise plus pending-note controls) are included
 * alongside the investigative tools, even with an explicit tools: allowlist.
 */
function withAdviseTool(toolNames: string[]): string[] {
  return [...new Set([
    ...toolNames, ...ADVISOR_COMMUNICATION_TOOLS,
    ...(toolNames.includes("request_stop") ? ADVISOR_STOP_TOOLS : []),
  ])];
}
/** How long the primary may be paused waiting for a slow advisor to catch
 *  up before the session gives up and moves on (upstream: 30_000ms). */
const CATCHUP_TIMEOUT_MS = 30_000;
/**
 * Backlog threshold (primary turns queued during the advisor's current review)
 * past which the primary pauses for the advisor to catch up. Upstream exposes
 * this as the `advisor.syncBacklog` setting with values `off | 1 | 3 | 5` and a
 * default of **`off`** — the primary is never gated on an advisor unless the
 * user opts in. Set `syncBacklog:` in `WATCHDOG.yml` to enable it.
 */
const BACKLOG_CATCHUP_DEFAULT: number | "off" = "off";

export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

type AdvisorSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

/** Exact generating route for a tool call; live session state is only a fallback. */
function advisorToolModelLabel(session: AdvisorSession, toolCallId: string): string | undefined {
  const state = session.agent.state as typeof session.agent.state & { streamMessage?: AgentMessage | null };
  const candidates = [state.streamingMessage ?? state.streamMessage, ...[...state.messages].reverse()]
    .filter((message): message is AgentMessage => Boolean(message));
  for (const message of candidates) {
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content) || !content.some(part => part.type === "toolCall" && part.id === toolCallId)) continue;
    if (typeof message.provider === "string" && typeof message.model === "string") {
      return `${message.provider}/${message.model}`;
    }
  }
  const active = state.model;
  return active && typeof active.provider === "string" && typeof active.id === "string"
    ? `${active.provider}/${active.id}`
    : undefined;
}

function installAdvisorMemoryOrDispose(session: AdvisorSession, contextTokens?: number) {
  try {
    return installAdvisorContextWindow(session.agent, contextTokens);
  } catch (err) {
    session.dispose();
    throw err;
  }
}

interface ActiveAdvisor {
  config: AdvisorConfig;
  /** OMP 18.2.4 exposes abort() but no abort-in-progress state, so its stop grant must fail closed. */
  stopEnabled: boolean;
  slug: string;
  /** Display source label — omitted (`undefined`) for the implicit/legacy
   *  default advisor so its rendered `<advisory>` output stays
   *  byte-identical to the single-advisor form (no `advisor="..."` attribute). */
  sourceName: string | undefined;
  session: AdvisorSession;
  memory: ReturnType<typeof installAdvisorContextWindow>;
  emissionGuard: AdvisorEmissionGuard;
  adviseState: ReturnType<typeof makeAdviseTool> extends Promise<{ state: infer S }> ? S : never;
  pendingMessages: AgentMessage[];
  awaitingBatch: AgentMessage[] | undefined;
  /** Completed primary turns represented by `awaitingBatch`. */
  awaitingTurns: number;
  /**
   * At most one catch-up observation waits behind the active review. New work
   * is merged into that item, matching upstream's single pending delta rather
   * than creating one paid model request per primary turn.
   */
  queue: { batch: AgentMessage[]; turns: number; wip: boolean }[];
  draining: boolean;
  disposed: boolean;
  generation: number;
  contextNotice?: string;
  status: AdvisorRuntimeStatus;
  /** A reset failure invalidates this runtime; ordinary provider errors remain retryable. */
  halted: boolean;
  /**
   * Whether to include the primary's reasoning in observations. Off by
   * default; an explicit opt-in can still fall back to text-only on error.
   * This does not control the advisor model's own thinking level.
   */
  includeThinking: boolean;
  maxBehind: number;
  flushTimeoutMs: number;
  /** Deliver pending observations when the primary settles instead of waiting for the turn batch (default true). */
  flushOnSettled: boolean;
  flushTimer: NodeJS.Timeout | undefined;
  wakeCount: number;
  modelRequestCount: number;
  toolCallCount: number;
}

export interface AdvisorStatusOverviewItem {
  name: string;
  /** Live provider/model route, or the unresolved configured selector. */
  model?: string;
  status: AdvisorRuntimeStatus;
  backlog: number;
  backlogMessages: number;
  pendingTurns: number;
  wakeEveryTurns: number;
  flushTimeoutMs: number;
  flushOnSettled?: boolean;
  wakes: number;
  modelRequests: number;
  toolCalls: number;
  context?: ContextWindowStatus;
  includePrimaryThinking?: boolean;
}

export interface OrchestratorHost {
  sendCustom(content: string, details: unknown, opts: { deliverAs: "steer"; triggerTurn?: boolean }): void;
  preserveAdvice(note: PendingAdvisorNote): void;
  pendingAdvice(advisor: string | undefined): PendingAdvisorNote[];
  reviseAdvice(advisor: string | undefined, adviceId: string, note: string, shortTitle?: string, severity?: AdvisorSeverity, model?: string): boolean;
  withdrawAdvice(advisor: string | undefined, adviceId: string): boolean;
  currentTool(): CurrentToolResult;
  requestStop(advisor: string | undefined, targetId: string, reason: string, model?: string): StopRequestResult;
  isStreaming(): boolean;
  isAborting(): boolean;
  /** Primary-owned latch, retained even when advisor runtimes are rebuilt. */
  isAutoResumeSuppressed(): boolean;
  hasQueuedWork(): boolean;
  setStatus(text: string): void;
}

export class AdvisorOrchestrator {
  #advisors: ActiveAdvisor[] = [];
  #host: OrchestratorHost;
  #primaryTurnsCompleted = 0;
  #interruptImmuneTurnStart: number | undefined;
  #preserveOnly = false;
  #paused = false;
  #pauseTransitions = new SerializedTransition();
  /** Build inputs captured at `start()` so `resetRuntimesOnly()` can rebuild
   *  each advisor's underlying session in place without needing the caller
   *  to re-supply them. */
  #buildInputs:
    | { ctx: ExtensionContext; modelRegistry: AdvisorModelRegistry; piModelRuntime?: ModelRuntime; agentDir: string; watchdogBlocks: string[]; sharedInstructions: string | undefined; isLegacySingle: boolean; contextFiles: { path: string; content: string }[] }
    | undefined;
  #activeChatModel: AdvisorModel | undefined;
  #activeChatThinkingLevel: ThinkingLevel | undefined;
  #activeChatRouteDirty = false;
  // Route changes and transcript-triggered child rebuilds both mutate the live
  // advisor sessions. Serialize them so a reset cannot publish a child built
  // for the route that was active before a concurrent model selection.
  #runtimeTransitions = new SerializedTransition();
  /** Shared FIFO for the non-interrupting "aside" channel across every
   *  advisor — matches upstream's single shared `yieldQueue` registration
   *  for the `"advisor"` key so nits from different advisors batch into one
   *  `<advisory>` block. */
  #asideQueue: PendingAdvisorNote[] = [];
  #asideFlushScheduled = false;
  #syncBacklog: SyncBacklogConfig = BACKLOG_CATCHUP_DEFAULT;
  #immuneTurns: number = ADVISOR_IMMUNE_TURNS_DEFAULT;
  /** Advisors skipped because their explicit `model:` did not resolve, kept so
   *  `/advisor status` reports `no_model` rather than hiding them entirely. */
  #noModelAdvisors: { name: string; model?: string; status: AdvisorRuntimeStatus }[] = [];

  constructor(host: OrchestratorHost, private readonly createSession = createAgentSession) {
    this.#host = host;
  }

  get advisorNames(): string[] {
    return this.#advisors.map(a => a.config.name);
  }

  /** Human-visible advisor identities, always including the live model route. */
  get advisorLabels(): string[] {
    return this.#advisors.map(advisor => `${advisor.config.name} · ${this.#modelLabel(advisor) ?? "no model"}`);
  }

  /** Whether any live advisor intentionally follows the primary chat route. */
  get usesActiveChatModel(): boolean {
    return this.#advisors.some(advisor => advisor.config.model === undefined);
  }

  /**
   * Retarget only unpinned advisors after the primary changes model/thinking.
   * Updating the existing child sessions preserves their review transcript,
   * backlog, deferred notes, duplicate guard, and interruption immunity; pinned
   * advisors in a mixed roster are untouched.
   */
  async followActiveChatModel(model: AdvisorModel | undefined, thinkingLevel: ThinkingLevel | undefined): Promise<void> {
    await this.#runtimeTransitions.run(async () => {
      const sameModel = model === this.#activeChatModel || (
        model !== undefined && this.#activeChatModel !== undefined &&
        model.provider === this.#activeChatModel.provider && model.id === this.#activeChatModel.id
      );
      if (!this.#activeChatRouteDirty && sameModel && thinkingLevel === this.#activeChatThinkingLevel) return;
      if (!model) {
        this.#activeChatModel = undefined;
        this.#activeChatThinkingLevel = thinkingLevel;
        this.#activeChatRouteDirty = false;
        return;
      }
      try {
        for (const advisor of this.#advisors) {
          if (advisor.disposed || advisor.config.model !== undefined) continue;
          await advisor.session.setModel(model);
          if (thinkingLevel !== undefined) advisor.session.setThinkingLevel(thinkingLevel);
        }
      } catch (err) {
        // Some earlier follower may already have accepted the route. Disable
        // the equality fast path until a later transition converges them all,
        // including when the user switches back to the cached route.
        this.#activeChatRouteDirty = true;
        throw err;
      }
      // Commit the route only after every follower accepted it. If one setter
      // rejects (for example after an auth failure), the next host event retries
      // the transition instead of treating the unapplied route as cached.
      this.#activeChatModel = model;
      this.#activeChatThinkingLevel = thinkingLevel;
      this.#activeChatRouteDirty = false;
    });
  }

  /**
   * Read-only transcript snapshots of running advisors, for the stream
   * viewer (`/advisor stream`). Advisors are in-memory sessions with no file
   * to tail, so this reads the live agent state directly. Message arrays are
   * copied per call; contents are shared read-only with the advisor.
   */
  transcriptSnapshot(name?: string): { name: string; model?: string; streaming: boolean; messages: AgentMessage[] }[] {
    const wanted = name?.toLowerCase();
    return this.#advisors
      .filter(a => !a.disposed && !a.halted)
      .filter(a => wanted === undefined || a.config.name.toLowerCase() === wanted)
      .map(a => {
        const state = a.session.agent.state as typeof a.session.agent.state & { streamMessage?: AgentMessage | null };
        // Pi names the in-flight message `streamingMessage`; OMP exposes the
        // same state as `streamMessage` through its legacy Agent surface.
        const streamingMessage = state.streamingMessage ?? state.streamMessage;
        return {
          name: a.config.name,
          model: this.#modelLabel(a),
          streaming: state.isStreaming,
          // Completed history excludes the in-flight response. Append its
          // read-only object so the viewer updates before message_end.
          messages: [
            ...state.messages,
            ...(streamingMessage ? [streamingMessage] : []),
          ],
        };
      });
  }

  statusOverview(): AdvisorStatusOverviewItem[] {
    // `backlog` is how many primary turns are waiting behind the one currently
    // being prompted — the honest "how far behind is this advisor" number, shown in
    // `/advisor status` rather than logged to stderr every time it happens.
    return [
      ...this.#advisors.map(a => ({
        name: a.config.name,
        model: this.#modelLabel(a),
        status: a.status,
        backlog: a.queue.reduce((sum, item) => sum + item.turns, 0),
        backlogMessages: a.queue.reduce((sum, item) => sum + item.batch.length, 0),
        pendingTurns: a.awaitingTurns,
        wakeEveryTurns: a.maxBehind,
        flushTimeoutMs: a.flushTimeoutMs,
        flushOnSettled: a.flushOnSettled,
        wakes: a.wakeCount,
        modelRequests: a.modelRequestCount,
        toolCalls: a.toolCallCount,
        context: a.memory.window.status,
        includePrimaryThinking: a.includeThinking,
      })),
      ...this.#noModelAdvisors.map(a => ({
        name: a.name,
        model: a.model,
        status: a.status,
        backlog: 0,
        backlogMessages: 0,
        pendingTurns: 0,
        wakeEveryTurns: DEFAULT_MAX_BEHIND,
        flushTimeoutMs: DEFAULT_FLUSH_TIMEOUT_MS,
        wakes: 0,
        modelRequests: 0,
        toolCalls: 0,
      })),
    ];
  }

  /**
   * Whether the primary must pause because an advisor has genuinely fallen
   * behind. No-op unless `syncBacklog` is configured (upstream default `off`).
   *
   * An advisor that cannot drain must never gate the primary — upstream skips
   * waiters for a runtime that is failing, quota-exhausted, or halted, since
   * its backlog cannot shrink until that resolves and the primary would
   * otherwise park for the whole 30s budget.
   */
  async waitForCatchup(): Promise<void> {
    if (this.#paused) return;
    const thresholds = normalizeSyncBacklog(this.#syncBacklog);
    if (!thresholds) return;
    const deadline = Date.now() + CATCHUP_TIMEOUT_MS;
    for (const advisor of this.#advisors) {
      if (this.#queuedTurns(advisor) >= thresholds.pauseAt) {
        while (
          this.#queuedTurns(advisor) > thresholds.resumeAt &&
          !advisor.disposed &&
          advisor.status === "running" &&
          Date.now() < deadline
        ) {
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }
  }

  /**
   * Build the roster of live advisors for a fresh session. Mirrors
   * upstream's per-session `SessionAdvisors` construction — always a full
   * rebuild, matching PROVENANCE.md's note that this port ties reset to
   * `session_start` (tear down + recreate) rather than porting every
   * individual omp reset call site.
   */
  async start(
    configs: DiscoveredAdvisorsLike,
    ctx: ExtensionContext,
    modelRegistry: AdvisorModelRegistry,
    agentDir: string,
    piModelRuntime?: ModelRuntime,
    activeThinkingLevel: ThinkingLevel | undefined = ctx.thinkingLevel,
  ): Promise<void> {
    await this.disposeAll();
    this.#noModelAdvisors = [];
    this.#syncBacklog = configs.syncBacklog ?? BACKLOG_CATCHUP_DEFAULT;
    this.#immuneTurns = configs.immuneTurns ?? ADVISOR_IMMUNE_TURNS_DEFAULT;
    this.#primaryTurnsCompleted = 0;
    this.#interruptImmuneTurnStart = undefined;
    this.#activeChatModel = ctx.model;
    this.#activeChatThinkingLevel = activeThinkingLevel;
    this.#activeChatRouteDirty = false;

    const watchdogBlocks = await discoverWatchdogFiles(ctx.cwd, agentDir);
    const roster = configs.advisors.length > 0 ? configs.advisors : [{ name: "default" }];
    const isLegacySingle = configs.advisors.length === 0;
    // Load through the host's resource contract rather than Pi's convenience
    // export, which OMP's legacy compatibility module does not expose.
    const contextFiles = await loadAdvisorContextFiles(ctx.cwd, agentDir);
    this.#buildInputs = { ctx, modelRegistry, piModelRuntime, agentDir, watchdogBlocks, sharedInstructions: configs.sharedInstructions, isLegacySingle, contextFiles };

    for (const config of roster) {
      if (config.enabled === false) continue;
      const advisor = await this.#buildAdvisor(config, isLegacySingle, watchdogBlocks, configs.sharedInstructions, ctx, modelRegistry, agentDir, contextFiles, configs, piModelRuntime);
      if (advisor) this.#advisors.push(advisor);
    }
  }

  async #buildAdvisor(
    config: AdvisorConfig,
    isLegacySingle: boolean,
    watchdogBlocks: string[],
    sharedInstructions: string | undefined,
    ctx: ExtensionContext,
    modelRegistry: AdvisorModelRegistry,
    agentDir: string,
    contextFiles: { path: string; content: string }[],
    configs?: DiscoveredAdvisorsLike,
    piModelRuntime?: ModelRuntime,
  ): Promise<ActiveAdvisor | undefined> {
    const slug = config.name === "default" ? "" : config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "advisor";
    const sourceName = isLegacySingle ? undefined : config.name;

    const resolvedModel = config.model ? this.#resolveModel(config.model, modelRegistry) : undefined;
    // An omitted model means "watch this chat", not "ask a new SDK session to
    // independently choose its configured default". The latter can select a
    // different provider—or one without credentials—when the primary used
    // --model. Explicit advisor selectors still resolve independently.
    const model = resolvedModel?.model ?? (config.model === undefined ? this.#activeChatModel : undefined);
    const thinkingLevel = resolvedModel?.thinkingLevel ?? (config.model === undefined ? this.#activeChatThinkingLevel : undefined);
    if (config.model && !model) {
      // Upstream skips an advisor whose explicit model does not resolve and
      // marks it `no_model`. Falling through to `createAgentSession` with no
      // model instead would silently hand the advisor the session default — the
      // primary's own model and latency — which is the opposite of what someone
      // pinning a fast advisor model asked for, and buries the config error.
      console.error(
        `[pi-omp-advisor] advisor "${config.name}": no model matched "${config.model}" — advisor not started. ` +
          `Expected "<provider>/<id>" naming a model pi has credentials for.`,
      );
      this.#noModelAdvisors.push({ name: config.name, model: config.model, status: "no_model" });
      return undefined;
    }

    const stopRequested = config.tools?.includes("request_stop") === true;
    const stopEnabled = stopRequested && !isOmpHost(ctx);
    if (stopRequested && !stopEnabled) {
      console.warn(`[pi-omp-advisor] advisor "${config.name}": request_stop is unavailable on OMP 18.2.4 because its extension context does not expose abort-in-progress state; the grant is disabled to fail closed.`);
    }
    const toolNames = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
    const effectiveToolNames = [...toolNames].filter(name => stopEnabled || name !== "request_stop");
    const resolvedToolNames = withAdviseTool(effectiveToolNames.map(resolveAdvisorToolName));

    const systemPrompt = await buildAdvisorSystemPrompt({
      watchdogBlocks,
      sharedInstructions,
      advisorInstructions: config.instructions,
      cwd: ctx.cwd,
      contextFiles,
    });

    const emissionGuard = new AdvisorEmissionGuard();

    // The emission guard gates at the tool-call boundary (passed into
    // makeAdviseTool), not here — see advise-tool.ts for why gating
    // downstream of AdviseState silently strands deferred notes.
    let session!: AdvisorSession;
    const currentModel = (toolCallId: string): string | undefined => advisorToolModelLabel(session, toolCallId);
    const routeAdvice = (note: PendingAdvisorNote) => this.#routeAdvice(sourceName, note);
    const { tool: adviseTool, controlTools, state: adviseState } = await makeAdviseTool(
      routeAdvice, note => emissionGuard.check(note), this.#pendingAccess(sourceName), undefined,
      stopEnabled ? this.#stopAccess(sourceName) : undefined,
      note => emissionGuard.remember(note),
      note => emissionGuard.forget(note),
      currentModel,
    );

    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      systemPromptOverride: () => systemPrompt,
      ...ADVISOR_RESOURCE_ISOLATION,
    });
    await resourceLoader.reload();

    let memory: ReturnType<typeof installAdvisorContextWindow>;
    try {
      const created = await this.createSession({
        sessionManager: SessionManager.inMemory(ctx.cwd),
        model,
        // Honors an omp-style `:level` suffix on the advisor's model selector.
        ...(thinkingLevel ? { thinkingLevel } : {}),
        cwd: ctx.cwd,
        ...advisorSessionToolOptions(ctx, resolvedToolNames, piModelRuntime),
        customTools: [adviseTool, ...controlTools],
        resourceLoader,
      });
      disableNestedHostAdvisor(ctx, created.session);
      memory = installAdvisorMemoryOrDispose(created.session, config.contextTokens);
      session = created.session;
    } catch (err) {
      console.error(`[pi-omp-advisor] advisor "${config.name}": failed to start: ${String(err)}`);
      return undefined;
    }

    return {
      config,
      stopEnabled,
      slug,
      sourceName,
      session,
      memory,
      emissionGuard,
      adviseState,
      pendingMessages: [],
      awaitingBatch: undefined,
      awaitingTurns: 0,
      queue: [],
      draining: false,
      disposed: false,
      generation: 0,
      contextNotice: "Observation begins here. Earlier session activity is not included in this fresh advisor context.",
      status: "running",
      halted: false,
      includeThinking: config.includePrimaryThinking ?? false,
      maxBehind: config.maxBehind ?? configs?.maxBehind ?? DEFAULT_MAX_BEHIND,
      flushTimeoutMs: config.flushTimeoutMs ?? configs?.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS,
      flushOnSettled: config.flushOnSettled ?? configs?.flushOnSettled ?? DEFAULT_FLUSH_ON_SETTLED,
      flushTimer: undefined,
      wakeCount: 0,
      modelRequestCount: 0,
      toolCallCount: 0,
    };
  }

  /**
   * Resolve an advisor's `model:` selector. Upstream documents this field as "a
   * model selector with an optional `:level` thinking suffix (e.g.
   * `x-ai/grok-code-fast:high`), resolved exactly like any other model
   * override" — always a concrete model, never a role name. The global `advisor`
   * role is upstream's fallback for an OMITTED `model`, not an accepted value
   * of the field.
   *
   * A `:level` suffix is HONORED, not merely tolerated: the parsed level is
   * returned and handed to `createAgentSession`'s `thinkingLevel` option, so
   * `x-ai/grok-code-fast:high` genuinely runs that advisor at high thinking, and
   * `:off` genuinely disables its thinking.
   */
  #resolveModel(
    selector: string,
    modelRegistry: AdvisorModelRegistry,
  ): { model: AdvisorModel; thinkingLevel?: ThinkingLevel } | undefined {
    // Try the selector VERBATIM first. Real model ids contain colons — OpenRouter
    // variant suffixes (`:free`, `:exacto`) and ids like `glm-4.7:max` — and
    // `max` is also a thinking-level name, so the literal id has to win before
    // any suffix is considered. Stripping unconditionally would silently
    // resolve the wrong model, or fail on a perfectly valid one.
    const direct = this.#lookupModel(selector, modelRegistry);
    if (direct) return { model: direct };

    // Only now consider a `:level` thinking suffix, and only if it is a level pi
    // actually knows.
    const suffix = selector.lastIndexOf(":");
    if (suffix > 0 && suffix > selector.indexOf("/")) {
      const level = selector.slice(suffix + 1).toLowerCase();
      if (ADVISOR_THINKING_LEVEL_SUFFIXES.has(level)) {
        const stripped = selector.slice(0, suffix);
        const model = this.#lookupModel(stripped, modelRegistry);
        if (model) return { model, thinkingLevel: level as ThinkingLevel };
      }
    }
    return undefined;
  }

  /** Split a `provider/id` key on the FIRST slash only — an id can itself contain
   *  slashes (e.g. provider `openrouter`, id `qwen/qwen3-coder`). */
  #lookupModel(modelKey: string, modelRegistry: AdvisorModelRegistry) {
    const sep = modelKey.indexOf("/");
    if (sep < 0) return undefined;
    const provider = modelKey.slice(0, sep);
    const id = modelKey.slice(sep + 1);
    if (!provider || !id) return undefined;
    return findAdvisorModel(modelRegistry, provider, id);
  }

  /**
   * Wait until every advisor has finished the work it already has queued, so a
   * headless run does not exit before its notes are recorded. Upstream's
   * `runPrintMode` does this explicitly (`waitForAdvisorCatchup`, threshold 1,
   * a 10-minute budget for the normal path and 30s on the error path) — without
   * it, print/json sessions tear the advisor down mid-turn and no advisory is
   * ever delivered.
   *
   * Stops waiting on an advisor that cannot make progress (anything other than
   * `running`), for the same reason upstream refuses to gate on a failing,
   * quota-exhausted, or halted runtime: its backlog will never drain and the
   * caller would burn the whole budget.
   */
  async drainForExit(timeoutMs: number, flushPending = false): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let drained = true;
    for (const advisor of this.#advisors) {
      if (flushPending) this.#flushAwaiting(advisor, false);
      while (
        !advisor.disposed &&
        advisor.status === "running" &&
        (advisor.queue.length > 0 || advisor.draining) &&
        Date.now() < deadline
      ) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (advisor.queue.length > 0 || advisor.draining) drained = false;
    }
    return drained;
  }

  /**
   * Stop observing and generating without destroying the advisor sessions or
   * the extension-owned inbox. Work not yet sent to an advisor is discarded;
   * already-generated asides are preserved in the visible inbox instead of
   * being delivered while paused.
   */
  setPaused(paused: boolean): Promise<void> {
    // A resume requested while pause is still aborting an advisor must wait for
    // that abort to settle. Otherwise #paused could flip false early and a
    // final advise call emitted by the cancelled turn could escape the inbox.
    return this.#pauseTransitions.run(async () => {
      if (this.#paused === paused) return;
      this.#paused = paused;
      if (!paused) {
        for (const advisor of this.#advisors) {
          advisor.contextNotice = "Observation resumed. Activity while paused was not sent to you; your view has a gap.";
        }
        return;
      }

      const asides = this.#asideQueue;
      this.#asideQueue = [];
      for (const note of asides) this.#host.preserveAdvice(note);

      const aborts: Promise<void>[] = [];
      for (const advisor of this.#advisors) {
        this.#clearFlushTimer(advisor);
        if (advisor.disposed) continue;
        advisor.pendingMessages = [];
        advisor.awaitingBatch = undefined;
        advisor.awaitingTurns = 0;
        advisor.queue = [];
        const discarded = advisor.adviseState.discardDeferredNotes();
        for (const note of discarded) advisor.emissionGuard.forget(note.note);
        // Reviews use Agent.prompt directly, so AgentSession's separate run
        // flag/idle waiter does not track them. Cancel at the same API layer.
        advisor.generation++;
        advisor.session.agent.abort();
        aborts.push(advisor.session.agent.waitForIdle());
      }
      await Promise.allSettled(aborts);
    });
  }

  async disposeAll(): Promise<void> {
    const retiring = this.#advisors;
    this.#advisors = [];
    for (const advisor of retiring) {
      this.#clearFlushTimer(advisor);
      advisor.disposed = true;
      advisor.generation++;
      advisor.pendingMessages = [];
      advisor.awaitingBatch = undefined;
      advisor.awaitingTurns = 0;
      advisor.queue = [];
      advisor.session.agent.abort();
    }
    await Promise.allSettled(retiring.map(async advisor => {
      try {
        // Reviews are prompted through Agent directly, so Session.dispose()
        // alone is not an awaitable cancellation barrier.
        await advisor.session.agent.waitForIdle();
      } finally {
        advisor.memory.dispose();
        advisor.session.dispose();
      }
    }));
  }

  /**
   * Reset each advisor's own delta cursor/context without touching the
   * session-level dedupe/immune-window state — the pi equivalent of
   * upstream's `resetAllRuntimes` (called around compaction/branch/tree
   * rewrites, where the primary's transcript changed shape underneath the
   * advisor but the conversation itself did not restart). Actually rebuilds
   * each advisor's underlying `AgentSession` (fresh in-memory context, since
   * the primary's transcript changed shape underneath it and any partial
   * advisor turn referencing old message ids would be stale) while reusing
   * the SAME `AdvisorEmissionGuard`/`AdviseState` instances so dedupe
   * history and the immune-turn window survive, matching upstream's
   * `resetAllRuntimes` vs `#resetAdvisorSessionState` distinction.
   */
  async resetRuntimesOnly(): Promise<void> {
    await this.#runtimeTransitions.run(() => this.#resetRuntimesOnly());
  }

  async #resetRuntimesOnly(): Promise<void> {
    if (!this.#buildInputs) return;
    const { ctx, modelRegistry, piModelRuntime, agentDir, watchdogBlocks, sharedInstructions, isLegacySingle, contextFiles } = this.#buildInputs;
    for (const advisor of this.#advisors) {
      this.#clearFlushTimer(advisor);
      if (advisor.disposed) continue;
      advisor.pendingMessages = [];
      advisor.awaitingBatch = undefined;
      advisor.awaitingTurns = 0;
      advisor.queue = [];
      const discarded = advisor.adviseState.discardDeferredNotes();
      for (const note of discarded) advisor.emissionGuard.forget(note.note);
      const oldSession = advisor.session;
      const oldMemory = advisor.memory;
      const rebuildGeneration = ++advisor.generation;
      advisor.contextNotice = "Your model context was rebuilt after a transcript change. Earlier history is not replayed; pending advice may refer to that older context.";
      try {
        oldSession.agent.abort();
        await oldSession.agent.waitForIdle();
        if (advisor.disposed || advisor.generation !== rebuildGeneration) continue;
        const resolvedModel = advisor.config.model ? this.#resolveModel(advisor.config.model, modelRegistry) : undefined;
        // Preserve the active chat route for implicit/unpinned advisors across
        // transcript rebuilds just as the initial child creation does.
        const model = resolvedModel?.model ?? (advisor.config.model === undefined ? this.#activeChatModel : undefined);
        const thinkingLevel = resolvedModel?.thinkingLevel ?? (advisor.config.model === undefined ? this.#activeChatThinkingLevel : undefined);
        const toolNames = advisor.config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(advisor.config.tools);
        const effectiveToolNames = [...toolNames].filter(name => advisor.stopEnabled || name !== "request_stop");
        const resolvedToolNames = withAdviseTool(effectiveToolNames.map(resolveAdvisorToolName));
        const systemPrompt = await buildAdvisorSystemPrompt({
          watchdogBlocks,
          sharedInstructions,
          advisorInstructions: advisor.config.instructions,
          cwd: ctx.cwd,
          contextFiles,
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir,
          systemPromptOverride: () => systemPrompt,
          ...ADVISOR_RESOURCE_ISOLATION,
        });
        await resourceLoader.reload();
        let replacementSession!: AdvisorSession;
        const currentModel = (toolCallId: string): string | undefined => advisorToolModelLabel(replacementSession, toolCallId);
        const routeAdvice = (note: PendingAdvisorNote) => this.#routeAdvice(advisor.sourceName, note);
        // Context rebuilds preserve the outbox and its IDs. The next review
        // receives a pending summary even though its model history is fresh.
        const { tool: adviseTool, controlTools, state: adviseState } = await makeAdviseTool(
          routeAdvice, note => advisor.emissionGuard.check(note),
          this.#pendingAccess(advisor.sourceName), advisor.adviseState,
          advisor.stopEnabled ? this.#stopAccess(advisor.sourceName) : undefined,
          note => advisor.emissionGuard.remember(note),
          note => advisor.emissionGuard.forget(note),
          currentModel,
        );
        const created = await this.createSession({
          sessionManager: SessionManager.inMemory(ctx.cwd),
          model,
          // Same `:level` handling as the initial build — a context reset must not
          // silently drop the advisor's configured thinking level.
          ...(thinkingLevel ? { thinkingLevel } : {}),
          cwd: ctx.cwd,
          ...advisorSessionToolOptions(ctx, resolvedToolNames, piModelRuntime),
          customTools: [adviseTool, ...controlTools],
          resourceLoader,
        });
        replacementSession = created.session;
        disableNestedHostAdvisor(ctx, created.session);
        const newMemory = installAdvisorMemoryOrDispose(created.session, advisor.config.contextTokens);
        if (advisor.disposed || advisor.generation !== rebuildGeneration) {
          newMemory.dispose();
          created.session.dispose();
          continue;
        }
        advisor.session = created.session;
        advisor.memory = newMemory;
        advisor.adviseState = adviseState;
        advisor.status = "running";
        advisor.halted = false;
        oldMemory.dispose();
        oldSession.dispose();
      } catch (err) {
        if (advisor.disposed || advisor.generation !== rebuildGeneration) continue;
        oldMemory.dispose();
        oldSession.dispose();
        advisor.status = "error";
        advisor.halted = true;
        console.error(`[pi-omp-advisor:${advisor.config.name}] failed to rebuild advisor session on context reset: ${String(err)}`);
      }
    }
  }

  /**
   * Feed one finalized primary message into every advisor's pending buffer.
   * The oldest-message deadline starts here—not at turn_end—so a finalized
   * assistant tool call can trigger a rare timeout review while its tool is
   * still running, without making tool lifecycle events special scheduler
   * inputs.
   */
  onMessage(message: AgentMessage): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || advisor.halted) continue;
      const hadPendingActivity = advisor.pendingMessages.length > 0 || Boolean(advisor.awaitingBatch);
      advisor.pendingMessages.push(message);
      if (!hadPendingActivity) this.#scheduleFlushTimer(advisor);
    }
  }

  #clearFlushTimer(advisor: ActiveAdvisor): void {
    if (advisor.flushTimer !== undefined) {
      clearTimeout(advisor.flushTimer);
      advisor.flushTimer = undefined;
    }
  }

  /** Arm one deadline for the oldest accumulated turn. Later turns do not move it. */
  #scheduleFlushTimer(advisor: ActiveAdvisor): void {
    if (
      advisor.flushTimer !== undefined || advisor.flushTimeoutMs <= 0 ||
      advisor.disposed || advisor.halted || this.#paused
    ) return;
    advisor.flushTimer = setTimeout(() => {
      advisor.flushTimer = undefined;
      if (advisor.disposed || advisor.halted || this.#paused) return;
      const batch = [
        ...(advisor.awaitingBatch ?? []),
        ...advisor.pendingMessages,
      ];
      const turns = advisor.awaitingTurns + (advisor.pendingMessages.length > 0 ? 1 : 0);
      advisor.awaitingBatch = undefined;
      advisor.awaitingTurns = 0;
      advisor.pendingMessages = [];
      if (batch.length > 0) this.#dispatch(advisor, batch, turns, this.#host.isStreaming());
    }, advisor.flushTimeoutMs);
  }

  #flushAwaiting(advisor: ActiveAdvisor, wip: boolean): void {
    this.#clearFlushTimer(advisor);
    const batch = advisor.awaitingBatch;
    const turns = advisor.awaitingTurns;
    advisor.awaitingBatch = undefined;
    advisor.awaitingTurns = 0;
    if (batch && batch.length > 0) this.#dispatch(advisor, batch, turns, wip);
  }

  /**
   * A new turn confirms prior accumulated turns were work-in-progress. Wake
   * only when the configured turn threshold has been reached; otherwise keep
   * accumulating behind the original timeout deadline.
   */
  onTurnStart(): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || advisor.halted || advisor.awaitingTurns < advisor.maxBehind) continue;
      this.#flushAwaiting(advisor, true);
    }
  }

  /** Close this primary turn into the single accumulated observation. */
  onTurnEnd(): void {
    if (this.#paused) return;
    this.#primaryTurnsCompleted++;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || advisor.halted || advisor.pendingMessages.length === 0) continue;
      const batch = advisor.pendingMessages;
      advisor.pendingMessages = [];
      advisor.awaitingBatch = advisor.awaitingBatch ? [...advisor.awaitingBatch, ...batch] : batch;
      advisor.awaitingTurns++;
      this.#scheduleFlushTimer(advisor);
    }
  }

  /**
   * Settlement marks queued work final but does not defeat turn batching. A
   * short run waits for more primary turns or the oldest-message deadline;
   * reaching the configured threshold still wakes immediately. An advisor
   * configured with `flushOnSettled: false` instead keeps whatever it has
   * batching for more primary turns or the oldest-message deadline, so a
   * short run's review stays economical. Mid-run batching is untouched in
   * both modes: only the final settlement flushes early.
   */
  onAgentSettled(): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || advisor.halted) continue;
      for (const waiting of advisor.queue) waiting.wip = false;
      if (advisor.pendingMessages.length > 0) {
        advisor.awaitingBatch = advisor.awaitingBatch
          ? [...advisor.awaitingBatch, ...advisor.pendingMessages]
          : advisor.pendingMessages;
        advisor.pendingMessages = [];
        advisor.awaitingTurns++;
      }
      if (advisor.awaitingTurns >= advisor.maxBehind || (advisor.flushOnSettled && advisor.awaitingTurns > 0)) {
        this.#flushAwaiting(advisor, false);
      }
    }
  }

  #queuedTurns(advisor: ActiveAdvisor): number {
    return advisor.queue.reduce((sum, item) => sum + item.turns, 0);
  }

  #dispatch(advisor: ActiveAdvisor, batch: AgentMessage[], turns: number, wip: boolean): void {
    if (batch.length === 0 || advisor.disposed || advisor.halted) return;
    advisor.wakeCount++;
    if (advisor.queue.length > 0) {
      const waiting = advisor.queue[0]!;
      waiting.batch = [...waiting.batch, ...batch];
      waiting.turns += turns;
      waiting.wip = wip;
    } else {
      advisor.queue.push({ batch, turns, wip });
    }
    void this.#drainAdvisor(advisor);
  }

  /**
   * Single-flight send loop for one advisor: runs the sole queued batch
   * and prompts them one at a time, so activity arriving while a batch is
   * still being reviewed is queued rather than dropped (mirrors upstream's
   * `#pending`/`#drain`).
   */
  async #drainAdvisor(advisor: ActiveAdvisor): Promise<void> {
    if (advisor.draining || advisor.disposed) return;
    advisor.draining = true;
    try {
      while (advisor.queue.length > 0 && !advisor.disposed && !advisor.halted && !this.#paused) {
        const { batch, wip } = advisor.queue.shift()!;
        // Deliberately not logged: an advisor running behind the primary is the
        // normal steady state, not an error, and upstream reports it through a
        // file logger rather than the user's session. Writing it to stderr put
        // a line of noise in the transcript for something nobody can act on.
        // Backlog is surfaced via `/advisor status` instead.
        await this.#sendBatch(advisor, batch, wip);
      }
    } finally {
      advisor.draining = false;
    }
  }

  /**
   * Render and send one batch, retrying once with thinking blocks stripped
   * on a first failure (upstream: a classifier-refusal retry strips
   * thinking then retries once before walking the model-fallback chain;
   * this port approximates that with a single blanket retry-without-thinking
   * rather than reproducing the refusal classifier itself).
   */
  async #sendBatch(advisor: ActiveAdvisor, batch: AgentMessage[], wip: boolean): Promise<void> {
    // Per-batch latch: `attempt` runs a second time on the thinking-stripped
    // retry, and the update bookkeeping below must happen exactly once per
    // batch — resetting the emission guard twice would hand one batch two
    // accepted notes instead of upstream's one-per-update budget.
    let updateBegun = false;
    const reviewSession = advisor.session;
    const reviewState = advisor.adviseState;
    const memory = advisor.memory;
    const generation = advisor.generation;
    const contextNotice = advisor.contextNotice;
    const attempt = async (includeThinking: boolean): Promise<boolean> => {
      const chunks = renderAdvisorDeltaMessages(batch, { wip, includeThinking }) ?? [];
      // Tool events do not trigger reviews. If stop access was explicitly
      // granted, sample the controller only when a scheduled review is about
      // to run so queued metadata cannot point at a tool that has since ended.
      if (advisor.stopEnabled) {
        const currentTool = this.#host.currentTool();
        if (currentTool.status !== "idle") {
          const activity = `### Current primary tool state (live runtime metadata)\n${JSON.stringify(currentTool)}\nThis is a point-in-time snapshot. request_stop revalidates the target and fails closed if it ended, changed, became ambiguous, or is no longer the sole active call.`;
          if (chunks.length === 0) chunks.push({ role: "user", text: activity });
          else chunks[chunks.length - 1]!.text += `\n\n${activity}`;
        }
      }
      if (chunks.length === 0) return false;
      if (!updateBegun) {
        updateBegun = true;
        advisor.emissionGuard.beginUpdate();
        reviewState.beginUpdate(wip);
      }
      if (contextNotice) chunks[chunks.length - 1]!.text += `\n\n### Observation context\n${contextNotice}`;
      const pendingSummary = reviewState.pendingSummary();
      if (pendingSummary) chunks[chunks.length - 1]!.text += `\n\n${pendingSummary}`;
      const messages: AgentMessage[] = chunks.map(c => ({
        role: "user",
        content: [{ type: "text", text: c.text }],
        timestamp: Date.now(),
      })) as AgentMessage[];
      // `session.prompt()` only accepts a single string; the underlying
      // `Agent.prompt()` (exposed via `session.agent`) accepts
      // `AgentMessage | AgentMessage[]` directly, which is what lets this
      // send upstream's real one-user-message-per-source-message split
      // instead of collapsing it back into one string.
      const previousMessageCount = reviewSession.agent.state.messages.length;
      let lastAssistant: AssistantMessage | undefined;
      try {
        await reviewSession.agent.prompt(messages);
      } finally {
        const generated = reviewSession.agent.state.messages.slice(previousMessageCount);
        const assistantMessages = generated.filter(message => message.role === "assistant") as AssistantMessage[];
        advisor.modelRequestCount += assistantMessages.length;
        advisor.toolCallCount += assistantMessages.reduce(
          (count, message) => count + message.content.filter(block => block.type === "toolCall").length,
          0,
        );
        lastAssistant = assistantMessages.at(-1);
        // Model-input trimming also runs between investigative tool calls. Once
        // the Agent settles, expire the same material from retained history.
        memory.trimRetainedHistory();
      }
      if (memory.interrupted || this.#paused || advisor.disposed || advisor.generation !== generation) return false;
      // Resolved does not necessarily mean completed: length limits, provider
      // deferral, errors, and aborts can all resolve without a finished review.
      if (lastAssistant?.stopReason !== "stop") {
        throw new Error(lastAssistant?.errorMessage ?? `Advisor review did not complete (${lastAssistant?.stopReason ?? "no response"})`);
      }
      reviewState.finishUpdate();
      if (advisor.contextNotice === contextNotice) advisor.contextNotice = undefined;
      return true;
    };
    try {
      if (await attempt(advisor.includeThinking)) advisor.status = "running";
    } catch (err) {
      if (this.#paused || advisor.disposed || advisor.generation !== generation) return;
      if (advisor.includeThinking) {
        advisor.includeThinking = false;
        try {
          if (await attempt(false)) advisor.status = "running";
          return;
        } catch (retryErr) {
          const discarded = advisor.adviseState.discardDeferredNotes();
          for (const note of discarded) advisor.emissionGuard.forget(note.note);
          advisor.status = "error";
          console.error(
            `[pi-omp-advisor:${advisor.config.name}] advisor turn failed after thinking-stripped retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
          return;
        }
      }
      const discarded = advisor.adviseState.discardDeferredNotes();
      for (const note of discarded) advisor.emissionGuard.forget(note.note);
      advisor.status = "error";
      console.error(`[pi-omp-advisor:${advisor.config.name}] advisor turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #isImmuneTurnActive(): boolean {
    return isAdvisorInterruptImmuneTurnActive({
      completedTurns: this.#primaryTurnsCompleted,
      immuneTurnStart: this.#interruptImmuneTurnStart,
      immuneTurns: this.#immuneTurns,
    });
  }

  #recordInterruptDelivered(): void {
    this.#interruptImmuneTurnStart = this.#primaryTurnsCompleted + 1;
  }

  /** Headless/print-mode callers set this so advisor notes never start a hidden primary turn. */
  setPreserveOnly(value: boolean): void {
    this.#preserveOnly = value;
  }

  #stopAccess(sourceName: string | undefined): PrimaryStopAccess {
    const allowed = () => !this.#paused && this.#advisors.some(advisor =>
      !advisor.disposed && advisor.sourceName === sourceName && advisor.stopEnabled,
    );
    return {
      currentTool: () => allowed() ? this.#host.currentTool() : { status: "disabled", activeCount: 0 },
      requestStop: (targetId, reason, model) => allowed()
        ? this.#host.requestStop(sourceName, targetId, reason, model)
        : { requested: false, status: "disabled", message: "This advisor is paused, disabled, or no longer active. No cancellation requested." },
    };
  }

  #pendingAccess(sourceName: string | undefined): PendingAdviceAccess {
    return {
      list: () => [
        ...this.#asideQueue.filter(note => note.advisor === sourceName).map(note => ({ ...note })),
        ...this.#host.pendingAdvice(sourceName),
      ],
      revise: (adviceId, note, shortTitle, severity, model) => {
        const index = this.#asideQueue.findIndex(item => item.adviceId === adviceId && item.advisor === sourceName);
        if (index < 0) return this.#host.reviseAdvice(sourceName, adviceId, note, shortTitle, severity, model);
        this.#asideQueue[index] = {
          ...this.#asideQueue[index]!,
          note,
          ...(shortTitle !== undefined ? { shortTitle: shortTitle || undefined } : {}),
          ...(severity !== undefined ? { severity } : {}),
          ...(model !== undefined ? { model } : {}),
          updatedAt: Date.now(),
        };
        return true;
      },
      withdraw: adviceId => {
        const index = this.#asideQueue.findIndex(item => item.adviceId === adviceId && item.advisor === sourceName);
        if (index < 0) return this.#host.withdrawAdvice(sourceName, adviceId);
        this.#asideQueue.splice(index, 1);
        return true;
      },
    };
  }

  #modelLabel(advisor: ActiveAdvisor): string | undefined {
    const model = advisor.session.agent.state.model;
    return model && typeof model.provider === "string" && typeof model.id === "string"
      ? `${model.provider}/${model.id}`
      : undefined;
  }

  #deliveryChannel(severity: AdvisorSeverity | undefined) {
    const streaming = this.#host.isStreaming();
    return resolveAdvisorDeliveryChannel({
      severity,
      autoResumeSuppressed: this.#host.isAutoResumeSuppressed(),
      preserveOnly: this.#preserveOnly,
      streaming,
      aborting: this.#host.isAborting(),
      terminalAnswerNoQueuedWork: !streaming && !this.#host.hasQueuedWork(),
      interruptImmuneTurnActive: isInterruptingSeverity(severity) && this.#isImmuneTurnActive(),
    });
  }

  #routeAdvice(sourceName: string | undefined, advice: PendingAdvisorNote): void {
    const { note, severity } = advice;
    const channel = this.#deliveryChannel(severity);

    if (DEBUG) {
      console.error(
        `[advisor:debug] route advisor=${sourceName ?? "default"} severity=${severity ?? "nit"} -> channel=${channel} ` +
          `(streaming=${this.#host.isStreaming()} preserveOnly=${this.#preserveOnly} immune=${this.#isImmuneTurnActive()}) note=${JSON.stringify(note.slice(0, 120))}`,
      );
    }

    const advisor = this.#advisors.find(candidate => candidate.sourceName === sourceName);
    const noteRecord: PendingAdvisorNote = {
      ...advice,
      advisor: sourceName,
      // New notes capture their generating route at tool execution. The
      // fallback labels legacy/restored state that predates model provenance.
      ...(!advice.model && advisor ? { model: this.#modelLabel(advisor) } : {}),
    };

    if (this.#paused) {
      this.#host.preserveAdvice(noteRecord);
      return;
    }
    if (channel === "aside") {
      this.#enqueueAside(noteRecord);
      return;
    }
    if (channel === "preserve") {
      this.#host.preserveAdvice(noteRecord);
      return;
    }
    // "steer"
    this.#recordInterruptDelivered();
    const content = formatAdvisorBatchContent([noteRecord]);
    this.#host.sendCustom(content, { notes: [noteRecord] }, { deliverAs: "steer", triggerTurn: true });
    this.markNotesStreamed([noteRecord]);
  }

  #enqueueAside(note: PendingAdvisorNote): void {
    this.#asideQueue.push(note);
    if (this.#asideFlushScheduled) return;
    this.#asideFlushScheduled = true;
    queueMicrotask(() => {
      this.#asideFlushScheduled = false;
      if (this.#paused || this.#asideQueue.length === 0) return;
      const queued = this.#asideQueue;
      this.#asideQueue = [];
      // The primary can finish or be stopped after enqueue but before handoff.
      // Recheck preservation without upgrading an aside into an interruption.
      const notes = queued.filter(note => {
        if (this.#deliveryChannel(note.severity) !== "preserve") return true;
        this.#host.preserveAdvice(note);
        return false;
      });
      if (notes.length === 0) return;
      const content = formatAdvisorBatchContent(notes);
      this.#host.sendCustom(content, { notes }, { deliverAs: "steer" });
      this.markNotesStreamed(notes);
    });
  }

  markNotesStreamed(notes: readonly (AdvisorNote & { adviceId?: string })[]): void {
    for (const note of notes) {
      if (!note.adviceId) continue;
      const adv = this.#advisors.find(a => a.sourceName === note.advisor);
      adv?.adviseState.markStreamed(note.adviceId, note as PendingAdvisorNote);
    }
  }
}

export interface DiscoveredAdvisorsLike {
  advisors: AdvisorConfig[];
  sharedInstructions: string | undefined;
  syncBacklog?: SyncBacklogConfig;
  immuneTurns?: number;
  maxBehind?: number;
  flushTimeoutMs?: number;
  /** Deliver pending observations at settlement; defaults to true when unset. */
  flushOnSettled?: boolean;
}
