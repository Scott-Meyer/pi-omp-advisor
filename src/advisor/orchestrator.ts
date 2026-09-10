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
 * Batching/cadence: pi's extension API doesn't expose omp's `willContinue`
 * flag directly, so WIP-vs-final is inferred from the surrounding event
 * sequence: a batch closed at `turn_end` is held (not yet sent) until either
 * another `turn_start` arrives (confirms it was mid-run — sent as `wip:
 * true`) or `agent_settled` arrives (confirms it was the run's last turn —
 * sent as `wip: false`). This reproduces the same WIP semantics upstream
 * gets from its own agent-core loop, one event later.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, loadProjectContextFiles, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
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
import type { CurrentToolResult, PrimaryStopAccess, PrimaryToolActivity, StopRequestResult } from "./primary-stop.ts";
import type { AdvisorConfig, SyncBacklogConfig } from "./watchdog-config.ts";
import { DEFAULT_FLUSH_TIMEOUT_MS, DEFAULT_MAX_BEHIND, discoverWatchdogFiles, normalizeSyncBacklog } from "./watchdog-config.ts";
import { buildAdvisorSystemPrompt } from "./system-prompt.ts";

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
 * Backlog threshold (batches queued during the advisor's last prompt call)
 * past which the primary pauses for the advisor to catch up. Upstream exposes
 * this as the `advisor.syncBacklog` setting with values `off | 1 | 3 | 5` and a
 * default of **`off`** — the primary is never gated on an advisor unless the
 * user opts in. Set `syncBacklog:` in `WATCHDOG.yml` to enable it.
 */
const BACKLOG_CATCHUP_DEFAULT: number | "off" = "off";

export type AdvisorRuntimeStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

interface ActiveAdvisor {
  config: AdvisorConfig;
  slug: string;
  /** Display source label — omitted (`undefined`) for the implicit/legacy
   *  default advisor so its rendered `<advisory>` output stays
   *  byte-identical to the single-advisor form (no `advisor="..."` attribute). */
  sourceName: string | undefined;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  memory: ReturnType<typeof installAdvisorContextWindow>;
  emissionGuard: AdvisorEmissionGuard;
  adviseState: ReturnType<typeof makeAdviseTool> extends Promise<{ state: infer S }> ? S : never;
  pendingMessages: AgentMessage[];
  awaitingBatch: AgentMessage[] | undefined;
  /**
   * Send queue: batches waiting to be prompted, in arrival order. `#dispatch`
   * always pushes here rather than calling `prompt()` directly, so activity
   * that arrives while a previous batch's advisor turn is still running is
   * preserved and drained in order instead of being dropped (upstream:
   * `AdvisorRuntime`'s own `#pending`/`#drain` single-flight loop).
   */
  queue: { batch: AgentMessage[]; wip: boolean; toolActivity?: PrimaryToolActivity }[];
  draining: boolean;
  disposed: boolean;
  generation: number;
  contextNotice?: string;
  status: AdvisorRuntimeStatus;
  /**
   * Whether to include the primary's reasoning in observations. Off by
   * default; an explicit opt-in can still fall back to text-only on error.
   * This does not control the advisor model's own thinking level.
   */
  includeThinking: boolean;
  maxBehind: number;
  flushTimeoutMs: number;
  flushTimer: NodeJS.Timeout | undefined;
}

export interface AdvisorStatusOverviewItem {
  name: string;
  status: AdvisorRuntimeStatus;
  backlog: number;
  backlogMessages: number;
  maxBehind: number;
  flushTimeoutMs: number;
  context?: ContextWindowStatus;
  includePrimaryThinking?: boolean;
}

export interface OrchestratorHost {
  sendCustom(content: string, details: unknown, opts: { deliverAs: "steer"; triggerTurn?: boolean }): void;
  preserveAdvice(note: PendingAdvisorNote): void;
  pendingAdvice(advisor: string | undefined): PendingAdvisorNote[];
  reviseAdvice(advisor: string | undefined, adviceId: string, note: string): boolean;
  withdrawAdvice(advisor: string | undefined, adviceId: string): boolean;
  currentTool(): CurrentToolResult;
  requestStop(advisor: string | undefined, targetId: string, reason: string): StopRequestResult;
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
    | { ctx: ExtensionContext; modelRuntime: ModelRuntime; agentDir: string; watchdogBlocks: string[]; sharedInstructions: string | undefined; isLegacySingle: boolean; contextFiles: { path: string; content: string }[] }
    | undefined;
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
  #noModelAdvisors: { name: string; status: AdvisorRuntimeStatus }[] = [];

  constructor(host: OrchestratorHost, private readonly createSession = createAgentSession) {
    this.#host = host;
  }

  get advisorNames(): string[] {
    return this.#advisors.map(a => a.config.name);
  }

  statusOverview(): AdvisorStatusOverviewItem[] {
    // `backlog` is how many batches are waiting behind the one currently being
    // prompted — the honest "how far behind is this advisor" number, shown in
    // `/advisor status` rather than logged to stderr every time it happens.
    return [
      ...this.#advisors.map(a => ({
        name: a.config.name,
        status: a.status,
        backlog: a.queue.length,
        backlogMessages: a.queue.reduce((sum, item) => sum + item.batch.length, 0),
        maxBehind: a.maxBehind,
        flushTimeoutMs: a.flushTimeoutMs,
        context: a.memory.window.status,
        includePrimaryThinking: a.includeThinking,
      })),
      ...this.#noModelAdvisors.map(a => ({
        name: a.name,
        status: a.status,
        backlog: 0,
        backlogMessages: 0,
        maxBehind: DEFAULT_MAX_BEHIND,
        flushTimeoutMs: DEFAULT_FLUSH_TIMEOUT_MS,
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
      if (advisor.queue.length >= thresholds.pauseAt) {
        while (
          advisor.queue.length > thresholds.resumeAt &&
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
    modelRuntime: ModelRuntime,
    agentDir: string,
  ): Promise<void> {
    await this.disposeAll();
    this.#noModelAdvisors = [];
    this.#syncBacklog = configs.syncBacklog ?? BACKLOG_CATCHUP_DEFAULT;
    this.#immuneTurns = configs.immuneTurns ?? ADVISOR_IMMUNE_TURNS_DEFAULT;
    this.#primaryTurnsCompleted = 0;
    this.#interruptImmuneTurnStart = undefined;

    const watchdogBlocks = await discoverWatchdogFiles(ctx.cwd, agentDir);
    const roster = configs.advisors.length > 0 ? configs.advisors : [{ name: "default" }];
    const isLegacySingle = configs.advisors.length === 0;
    // `ctx.getSystemPromptOptions().contextFiles` is the same AGENTS.md/
    // project-instructions set the primary's own system prompt gets — fed to
    // context-files.md so the advisor is held to the same standing rules the
    // primary was given (upstream: `formatAdvisorContextPrompt`).
    // `loadProjectContextFiles` is the same AGENTS.md/project-instructions
    // discovery pi's own resource loader runs to build the PRIMARY's system
    // prompt (`ctx.getSystemPromptOptions().contextFiles` for command
    // contexts) — called directly here since `session_start`'s `ctx` is a
    // plain `ExtensionContext`, which doesn't expose that method.
    const contextFiles = loadProjectContextFiles({ cwd: ctx.cwd, agentDir });
    this.#buildInputs = { ctx, modelRuntime, agentDir, watchdogBlocks, sharedInstructions: configs.sharedInstructions, isLegacySingle, contextFiles };

    for (const config of roster) {
      if (config.enabled === false) continue;
      const advisor = await this.#buildAdvisor(config, isLegacySingle, watchdogBlocks, configs.sharedInstructions, ctx, modelRuntime, agentDir, contextFiles, configs);
      if (advisor) this.#advisors.push(advisor);
    }
  }

  async #buildAdvisor(
    config: AdvisorConfig,
    isLegacySingle: boolean,
    watchdogBlocks: string[],
    sharedInstructions: string | undefined,
    ctx: ExtensionContext,
    modelRuntime: ModelRuntime,
    agentDir: string,
    contextFiles: { path: string; content: string }[],
    configs?: DiscoveredAdvisorsLike,
  ): Promise<ActiveAdvisor | undefined> {
    const slug = config.name === "default" ? "" : config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "advisor";
    const sourceName = isLegacySingle ? undefined : config.name;

    const resolvedModel = config.model ? this.#resolveModel(config.model, modelRuntime) : undefined;
    const model = resolvedModel?.model;
    const thinkingLevel = resolvedModel?.thinkingLevel;
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
      this.#noModelAdvisors.push({ name: config.name, status: "no_model" });
      return undefined;
    }

    const toolNames = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
    const resolvedToolNames = withAdviseTool([...toolNames].map(resolveAdvisorToolName));

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
    const routeAdvice = (note: PendingAdvisorNote) => this.#routeAdvice(sourceName, note);
    const { tool: adviseTool, controlTools, state: adviseState } = await makeAdviseTool(
      routeAdvice, note => emissionGuard.accept(note), this.#pendingAccess(sourceName), undefined,
      config.tools?.includes("request_stop") ? this.#stopAccess(sourceName) : undefined,
      note => emissionGuard.remember(note),
    );

    const resourceLoader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      systemPromptOverride: () => systemPrompt,
      ...ADVISOR_RESOURCE_ISOLATION,
    });
    await resourceLoader.reload();

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      const created = await this.createSession({
        sessionManager: SessionManager.inMemory(ctx.cwd),
        modelRuntime,
        model,
        // Honors an omp-style `:level` suffix on the advisor's model selector.
        ...(thinkingLevel ? { thinkingLevel } : {}),
        cwd: ctx.cwd,
        tools: resolvedToolNames,
        customTools: [adviseTool, ...controlTools],
        resourceLoader,
      });
      session = created.session;
    } catch (err) {
      console.error(`[pi-omp-advisor] advisor "${config.name}": failed to start: ${String(err)}`);
      return undefined;
    }

    return {
      config,
      slug,
      sourceName,
      session,
      memory: installAdvisorContextWindow(session.agent, config.contextTokens),
      emissionGuard,
      adviseState,
      pendingMessages: [],
      awaitingBatch: undefined,
      queue: [],
      draining: false,
      disposed: false,
      generation: 0,
      contextNotice: "Observation begins here. Earlier session activity is not included in this fresh advisor context.",
      status: "running",
      includeThinking: config.includePrimaryThinking ?? false,
      maxBehind: config.maxBehind ?? configs?.maxBehind ?? DEFAULT_MAX_BEHIND,
      flushTimeoutMs: config.flushTimeoutMs ?? configs?.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS,
      flushTimer: undefined,
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
    modelRuntime: ModelRuntime,
  ): { model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; thinkingLevel?: ThinkingLevel } | undefined {
    // Try the selector VERBATIM first. Real model ids contain colons — OpenRouter
    // variant suffixes (`:free`, `:exacto`) and ids like `glm-4.7:max` — and
    // `max` is also a thinking-level name, so the literal id has to win before
    // any suffix is considered. Stripping unconditionally would silently
    // resolve the wrong model, or fail on a perfectly valid one.
    const direct = this.#lookupModel(selector, modelRuntime);
    if (direct) return { model: direct };

    // Only now consider a `:level` thinking suffix, and only if it is a level pi
    // actually knows.
    const suffix = selector.lastIndexOf(":");
    if (suffix > 0 && suffix > selector.indexOf("/")) {
      const level = selector.slice(suffix + 1).toLowerCase();
      if (ADVISOR_THINKING_LEVEL_SUFFIXES.has(level)) {
        const stripped = selector.slice(0, suffix);
        const model = this.#lookupModel(stripped, modelRuntime);
        if (model) return { model, thinkingLevel: level as ThinkingLevel };
      }
    }
    return undefined;
  }

  /** Split a `provider/id` key on the FIRST slash only — an id can itself contain
   *  slashes (e.g. provider `openrouter`, id `qwen/qwen3-coder`). */
  #lookupModel(modelKey: string, modelRuntime: ModelRuntime) {
    const sep = modelKey.indexOf("/");
    if (sep < 0) return undefined;
    const provider = modelKey.slice(0, sep);
    const id = modelKey.slice(sep + 1);
    if (!provider || !id) return undefined;
    return modelRuntime.getModel(provider, id);
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
  async drainForExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let drained = true;
    for (const advisor of this.#advisors) {
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
        advisor.queue = [];
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
    for (const advisor of this.#advisors) {
      this.#clearFlushTimer(advisor);
      advisor.disposed = true;
      advisor.memory.dispose();
      advisor.session.dispose();
    }
    this.#advisors = [];
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
    if (!this.#buildInputs) return;
    const { ctx, modelRuntime, agentDir, watchdogBlocks, sharedInstructions, isLegacySingle, contextFiles } = this.#buildInputs;
    for (const advisor of this.#advisors) {
      this.#clearFlushTimer(advisor);
      if (advisor.disposed) continue;
      advisor.pendingMessages = [];
      advisor.awaitingBatch = undefined;
      advisor.queue = [];
      const oldSession = advisor.session;
      const oldMemory = advisor.memory;
      advisor.generation++;
      advisor.contextNotice = "Your model context was rebuilt after a transcript change. Earlier history is not replayed; pending advice may refer to that older context.";
      try {
        oldSession.agent.abort();
        await oldSession.agent.waitForIdle();
        const resolvedModel = advisor.config.model ? this.#resolveModel(advisor.config.model, modelRuntime) : undefined;
        const model = resolvedModel?.model;
        const thinkingLevel = resolvedModel?.thinkingLevel;
        const toolNames = advisor.config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(advisor.config.tools);
        const resolvedToolNames = withAdviseTool([...toolNames].map(resolveAdvisorToolName));
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
        const routeAdvice = (note: PendingAdvisorNote) => this.#routeAdvice(advisor.sourceName, note);
        // Context rebuilds preserve the outbox and its IDs. The next review
        // receives a pending summary even though its model history is fresh.
        const { tool: adviseTool, controlTools, state: adviseState } = await makeAdviseTool(
          routeAdvice, note => advisor.emissionGuard.accept(note),
          this.#pendingAccess(advisor.sourceName), advisor.adviseState,
          advisor.config.tools?.includes("request_stop") ? this.#stopAccess(advisor.sourceName) : undefined,
          note => advisor.emissionGuard.remember(note),
        );
        const created = await this.createSession({
          sessionManager: SessionManager.inMemory(ctx.cwd),
          modelRuntime,
          model,
          // Same `:level` handling as the initial build — a context reset must not
          // silently drop the advisor's configured thinking level.
          ...(thinkingLevel ? { thinkingLevel } : {}),
          cwd: ctx.cwd,
          tools: resolvedToolNames,
          customTools: [adviseTool, ...controlTools],
          resourceLoader,
        });
        advisor.session = created.session;
        advisor.memory = installAdvisorContextWindow(created.session.agent, advisor.config.contextTokens);
        advisor.adviseState = adviseState;
        advisor.status = "running";
        oldMemory.dispose();
        oldSession.dispose();
      } catch (err) {
        advisor.status = "error";
        console.error(`[pi-omp-advisor:${advisor.config.name}] failed to rebuild advisor session on context reset: ${String(err)}`);
      }
    }
  }

  /** Feed one finalized primary message into every advisor's pending buffer. */
  onMessage(message: AgentMessage): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      if (advisor.disposed) continue;
      advisor.pendingMessages.push(message);
    }
  }

  #clearFlushTimer(advisor: ActiveAdvisor): void {
    if (advisor.flushTimer !== undefined) {
      clearTimeout(advisor.flushTimer);
      advisor.flushTimer = undefined;
    }
  }

  #scheduleFlushTimer(advisor: ActiveAdvisor): void {
    this.#clearFlushTimer(advisor);
    if (advisor.flushTimeoutMs > 0 && !advisor.disposed && !this.#paused) {
      advisor.flushTimer = setTimeout(() => {
        advisor.flushTimer = undefined;
        if (advisor.disposed || this.#paused || !advisor.awaitingBatch || advisor.awaitingBatch.length === 0) return;
        const batch = advisor.awaitingBatch;
        advisor.awaitingBatch = undefined;
        this.#dispatch(advisor, batch, true);
      }, advisor.flushTimeoutMs);
    }
  }

  /**
   * Stop-enabled advisors receive the call before its result. Flush only their
   * collected transcript, with compact runtime metadata; do not block execution
   * or grant fuller tool outputs. Other advisors retain the original cadence.
   */
  onToolStart(toolActivity: PrimaryToolActivity): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || !advisor.config.tools?.includes("request_stop")) continue;
      this.#clearFlushTimer(advisor);
      const batch = [...(advisor.awaitingBatch ?? []), ...advisor.pendingMessages];
      advisor.awaitingBatch = undefined;
      advisor.pendingMessages = [];
      this.#dispatch(advisor, batch, true, toolActivity);
    }
  }

  /** Called on `turn_start`: release any batch that was held pending WIP confirmation, marked WIP (a new turn is starting, so the prior batch wasn't final). */
  onTurnStart(): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      this.#clearFlushTimer(advisor);
      if (advisor.disposed || !advisor.awaitingBatch) continue;
      const batch = advisor.awaitingBatch;
      advisor.awaitingBatch = undefined;
      this.#dispatch(advisor, batch, true);
    }
  }

  /** Called on `turn_end`: close the current pending buffer into an awaiting batch. */
  onTurnEnd(): void {
    if (this.#paused) return;
    this.#primaryTurnsCompleted++;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || advisor.pendingMessages.length === 0) continue;
      const batch = advisor.pendingMessages;
      advisor.pendingMessages = [];
      // A previous awaiting batch that was never confirmed (shouldn't
      // normally happen — turn_start always resolves it first) is folded in
      // ahead of the new one rather than dropped.
      advisor.awaitingBatch = advisor.awaitingBatch ? [...advisor.awaitingBatch, ...batch] : batch;
      this.#scheduleFlushTimer(advisor);
    }
  }

  /** Called on `agent_settled`: the run is genuinely done; flush every remaining batch as final. */
  onAgentSettled(): void {
    if (this.#paused) return;
    for (const advisor of this.#advisors) {
      this.#clearFlushTimer(advisor);
      if (advisor.disposed) continue;
      const batch = advisor.awaitingBatch ?? (advisor.pendingMessages.length > 0 ? advisor.pendingMessages : undefined);
      advisor.awaitingBatch = undefined;
      advisor.pendingMessages = [];
      if (batch) this.#dispatch(advisor, batch, false);
    }
  }

  #dispatch(advisor: ActiveAdvisor, batch: AgentMessage[], wip: boolean, toolActivity?: PrimaryToolActivity): void {
    if (batch.length === 0 && !toolActivity) return;
    const maxBehind = advisor.maxBehind;
    if (advisor.queue.length >= maxBehind && advisor.queue.length > 0) {
      // Coalesce into the tail of the queue
      const last = advisor.queue[advisor.queue.length - 1]!;
      last.batch = [...last.batch, ...batch];
      last.wip = wip;
      if (toolActivity) last.toolActivity = toolActivity;
    } else {
      advisor.queue.push({ batch, wip, toolActivity });
    }
    void this.#drainAdvisor(advisor);
  }

  /**
   * Single-flight send loop for one advisor: pops queued batches in order
   * and prompts them one at a time, so activity arriving while a batch is
   * still being reviewed is queued rather than dropped (mirrors upstream's
   * `#pending`/`#drain`).
   */
  async #drainAdvisor(advisor: ActiveAdvisor): Promise<void> {
    if (advisor.draining || advisor.disposed) return;
    advisor.draining = true;
    try {
      while (advisor.queue.length > 0 && !advisor.disposed && !this.#paused) {
        const { batch, wip, toolActivity } = advisor.queue.shift()!;
        // Deliberately not logged: an advisor running behind the primary is the
        // normal steady state, not an error, and upstream reports it through a
        // file logger rather than the user's session. Writing it to stderr put
        // a line of noise in the transcript for something nobody can act on.
        // Backlog is surfaced via `/advisor status` instead.
        await this.#sendBatch(advisor, batch, wip, toolActivity);
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
  async #sendBatch(advisor: ActiveAdvisor, batch: AgentMessage[], wip: boolean, toolActivity?: PrimaryToolActivity): Promise<void> {
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
      if (toolActivity) {
        const activity = `### Primary tool activity (runtime metadata)\n${JSON.stringify(toolActivity)}\nThis call entered the execution lifecycle; it may still be in preflight. No result yet. Check current_tool before any stop request; this snapshot may be stale.`;
        if (chunks.length === 0) chunks.push({ role: "user", text: activity });
        else chunks[chunks.length - 1]!.text += `\n\n${activity}`;
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
        lastAssistant = reviewSession.agent.state.messages.slice(previousMessageCount).reverse().find(message => message.role === "assistant") as AssistantMessage | undefined;
      } finally {
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
          advisor.status = "error";
          console.error(
            `[pi-omp-advisor:${advisor.config.name}] advisor turn failed after thinking-stripped retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
          return;
        }
      }
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
      !advisor.disposed && advisor.sourceName === sourceName && advisor.config.tools?.includes("request_stop"),
    );
    return {
      currentTool: () => allowed() ? this.#host.currentTool() : { status: "disabled", activeCount: 0 },
      requestStop: (targetId, reason) => allowed()
        ? this.#host.requestStop(sourceName, targetId, reason)
        : { requested: false, status: "disabled", message: "This advisor is paused, disabled, or no longer active. No cancellation requested." },
    };
  }

  #pendingAccess(sourceName: string | undefined): PendingAdviceAccess {
    return {
      list: () => [
        ...this.#asideQueue.filter(note => note.advisor === sourceName).map(note => ({ ...note })),
        ...this.#host.pendingAdvice(sourceName),
      ],
      revise: (adviceId, note) => {
        const index = this.#asideQueue.findIndex(item => item.adviceId === adviceId && item.advisor === sourceName);
        if (index < 0) return this.#host.reviseAdvice(sourceName, adviceId, note);
        this.#asideQueue[index] = { ...this.#asideQueue[index]!, note, updatedAt: Date.now() };
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

    const noteRecord: PendingAdvisorNote = { ...advice, advisor: sourceName };

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
    });
  }
}

export interface DiscoveredAdvisorsLike {
  advisors: AdvisorConfig[];
  sharedInstructions: string | undefined;
  syncBacklog?: SyncBacklogConfig;
  immuneTurns?: number;
  maxBehind?: number;
  flushTimeoutMs?: number;
}
