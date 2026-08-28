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
  type AdvisorSeverity,
} from "./advise-logic.ts";
import { makeAdviseTool } from "./advise-tool.ts";
import { AdvisorEmissionGuard } from "./emission-guard.ts";
import { renderAdvisorDeltaMessages } from "./delta-render.ts";
import type { AdvisorConfig } from "./watchdog-config.ts";
import { discoverWatchdogFiles } from "./watchdog-config.ts";
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
 * The advise tool's name must always be in the list alongside them.
 */
function withAdviseTool(toolNames: string[]): string[] {
  return toolNames.includes(ADVISE_TOOL_NAME) ? toolNames : [...toolNames, ADVISE_TOOL_NAME];
}

const ADVISE_TOOL_NAME = "advise";
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
  queue: { batch: AgentMessage[]; wip: boolean }[];
  draining: boolean;
  disposed: boolean;
  status: AdvisorRuntimeStatus;
  /**
   * Whether to render/send thinking blocks for this advisor's context.
   * Upstream (`runtime.ts` `#includeThinking`) starts `true` and is flipped
   * to `false` only after a classifier refusal, then retried once with
   * thinking stripped — see `#drainAdvisor`.
   */
  includeThinking: boolean;
}

export interface OrchestratorHost {
  sendCustom(content: string, details: unknown, opts: { deliverAs: "steer" | "nextTurn"; triggerTurn?: boolean }): void;
  isStreaming(): boolean;
  isAborting(): boolean;
  hasQueuedWork(): boolean;
  setStatus(text: string): void;
}

export class AdvisorOrchestrator {
  #advisors: ActiveAdvisor[] = [];
  #host: OrchestratorHost;
  #primaryTurnsCompleted = 0;
  #interruptImmuneTurnStart: number | undefined;
  #autoResumeSuppressed = false;
  #preserveOnly = false;
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
  #asideQueue: AdvisorNote[] = [];
  #asideFlushScheduled = false;
  #syncBacklog: number | "off" = BACKLOG_CATCHUP_DEFAULT;
  #immuneTurns: number = ADVISOR_IMMUNE_TURNS_DEFAULT;
  /** Advisors skipped because their explicit `model:` did not resolve, kept so
   *  `/advisor status` reports `no_model` rather than hiding them entirely. */
  #noModelAdvisors: { name: string; status: AdvisorRuntimeStatus }[] = [];

  constructor(host: OrchestratorHost) {
    this.#host = host;
  }

  get advisorNames(): string[] {
    return this.#advisors.map(a => a.config.name);
  }

  statusOverview(): { name: string; status: AdvisorRuntimeStatus; backlog: number }[] {
    // `backlog` is how many batches are waiting behind the one currently being
    // prompted — the honest "how far behind is this advisor" number, shown in
    // `/advisor status` rather than logged to stderr every time it happens.
    return [
      ...this.#advisors.map(a => ({ name: a.config.name, status: a.status, backlog: a.queue.length })),
      ...this.#noModelAdvisors.map(a => ({ name: a.name, status: a.status, backlog: 0 })),
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
    const threshold = this.#syncBacklog;
    if (threshold === "off") return;
    const deadline = Date.now() + CATCHUP_TIMEOUT_MS;
    for (const advisor of this.#advisors) {
      while (
        advisor.queue.length >= threshold &&
        !advisor.disposed &&
        advisor.status === "running" &&
        Date.now() < deadline
      ) {
        await new Promise(r => setTimeout(r, 100));
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
    this.#autoResumeSuppressed = false;

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
      const advisor = await this.#buildAdvisor(config, isLegacySingle, watchdogBlocks, configs.sharedInstructions, ctx, modelRuntime, agentDir, contextFiles);
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
    const routeAdvice = (note: string, severity: AdvisorSeverity | undefined) => {
      this.#routeAdvice(sourceName, note, severity);
    };
    const { tool: adviseTool, state: adviseState } = await makeAdviseTool(routeAdvice, note =>
      emissionGuard.accept(note),
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
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(ctx.cwd),
        modelRuntime,
        model,
        // Honors an omp-style `:level` suffix on the advisor's model selector.
        ...(thinkingLevel ? { thinkingLevel } : {}),
        cwd: ctx.cwd,
        tools: resolvedToolNames,
        customTools: [adviseTool],
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
      emissionGuard,
      adviseState,
      pendingMessages: [],
      awaitingBatch: undefined,
      queue: [],
      draining: false,
      disposed: false,
      status: "running",
      includeThinking: true,
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

  async disposeAll(): Promise<void> {
    for (const advisor of this.#advisors) {
      advisor.disposed = true;
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
      if (advisor.disposed) continue;
      advisor.pendingMessages = [];
      advisor.awaitingBatch = undefined;
      advisor.queue = [];
      const oldSession = advisor.session;
      try {
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
        const routeAdvice = (note: string, severity: AdvisorSeverity | undefined) => {
          this.#routeAdvice(advisor.sourceName, note, severity);
        };
        // Rebuild the advise tool bound to the SAME AdviseState instance —
        // makeAdviseTool always constructs a fresh AdviseState, so reuse the
        // existing one's dedupe map by swapping its onAdvice callback isn't
        // exposed; instead this reconstructs a tool with a fresh AdviseState
        // deliberately reset in step with the fresh session's empty context.
        // (Delivered-note dedupe living in AdviseState, not just the emission
        // guard, is upstream-scoped per `AdvisorRuntime.reset()` call, which
        // upstream's OWN `resetAllRuntimes` also does NOT reset — see
        // upstream `runtime.ts`; only `#resetAdvisorSessionState` calls
        // `resetDeliveredNotes()`. This port's rebuilt AdviseState losing
        // that history on a within-conversation rewrite is a known, narrow
        // deviation from upstream's finer-grained separation, traded for
        // implementation simplicity — see PROVENANCE.md.)
        const { tool: adviseTool, state: adviseState } = await makeAdviseTool(routeAdvice, note =>
          advisor.emissionGuard.accept(note),
        );
        const created = await createAgentSession({
          sessionManager: SessionManager.inMemory(ctx.cwd),
          modelRuntime,
          model,
          // Same `:level` handling as the initial build — a context reset must not
          // silently drop the advisor's configured thinking level.
          ...(thinkingLevel ? { thinkingLevel } : {}),
          cwd: ctx.cwd,
          tools: resolvedToolNames,
          customTools: [adviseTool],
          resourceLoader,
        });
        advisor.session = created.session;
        advisor.adviseState = adviseState;
        advisor.status = "running";
        oldSession.dispose();
      } catch (err) {
        advisor.status = "error";
        console.error(`[pi-omp-advisor:${advisor.config.name}] failed to rebuild advisor session on context reset: ${String(err)}`);
      }
    }
  }

  /** Feed one finalized primary message into every advisor's pending buffer. */
  onMessage(message: AgentMessage): void {
    for (const advisor of this.#advisors) {
      if (advisor.disposed) continue;
      advisor.pendingMessages.push(message);
    }
  }

  /** Called on `turn_start`: release any batch that was held pending WIP confirmation, marked WIP (a new turn is starting, so the prior batch wasn't final). */
  onTurnStart(): void {
    for (const advisor of this.#advisors) {
      if (advisor.disposed || !advisor.awaitingBatch) continue;
      const batch = advisor.awaitingBatch;
      advisor.awaitingBatch = undefined;
      this.#dispatch(advisor, batch, true);
    }
  }

  /** Called on `turn_end`: close the current pending buffer into an awaiting batch. */
  onTurnEnd(): void {
    this.#primaryTurnsCompleted++;
    for (const advisor of this.#advisors) {
      if (advisor.disposed || advisor.pendingMessages.length === 0) continue;
      const batch = advisor.pendingMessages;
      advisor.pendingMessages = [];
      // A previous awaiting batch that was never confirmed (shouldn't
      // normally happen — turn_start always resolves it first) is folded in
      // ahead of the new one rather than dropped.
      advisor.awaitingBatch = advisor.awaitingBatch ? [...advisor.awaitingBatch, ...batch] : batch;
    }
  }

  /** Called on `agent_settled`: the run is genuinely done; flush every remaining batch as final. */
  onAgentSettled(): void {
    for (const advisor of this.#advisors) {
      if (advisor.disposed) continue;
      const batch = advisor.awaitingBatch ?? (advisor.pendingMessages.length > 0 ? advisor.pendingMessages : undefined);
      advisor.awaitingBatch = undefined;
      advisor.pendingMessages = [];
      if (batch) this.#dispatch(advisor, batch, false);
    }
  }

  #dispatch(advisor: ActiveAdvisor, batch: AgentMessage[], wip: boolean): void {
    advisor.queue.push({ batch, wip });
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
      while (advisor.queue.length > 0 && !advisor.disposed) {
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
    const attempt = async (includeThinking: boolean): Promise<void> => {
      const chunks = renderAdvisorDeltaMessages(batch, { wip, includeThinking });
      if (!chunks) return;
      if (!updateBegun) {
        updateBegun = true;
        // Guard budget is reset before AdviseState's, so a WIP→final flush of
        // deferred notes is never measured against the previous update's
        // already-spent budget. The guard now gates at the tool boundary, so
        // the flush itself is no longer re-gated at all — each deferred note
        // already spent the budget of the update it was raised in.
        advisor.emissionGuard.beginUpdate();
        advisor.adviseState.beginUpdate(wip);
      }
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
      await advisor.session.agent.prompt(messages);
    };
    try {
      await attempt(advisor.includeThinking);
      advisor.status = "running";
    } catch (err) {
      if (advisor.includeThinking) {
        advisor.includeThinking = false;
        try {
          await attempt(false);
          advisor.status = "running";
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

  /** Set on a deliberate user interrupt; cleared on a user-driven resume. Wired from index.ts. */
  setAutoResumeSuppressed(value: boolean): void {
    this.#autoResumeSuppressed = value;
  }

  /** Headless/print-mode callers set this so advisor notes never start a hidden primary turn. */
  setPreserveOnly(value: boolean): void {
    this.#preserveOnly = value;
  }

  #routeAdvice(sourceName: string | undefined, note: string, severity: AdvisorSeverity | undefined): void {
    const interrupting = isInterruptingSeverity(severity);
    const channel = resolveAdvisorDeliveryChannel({
      severity,
      autoResumeSuppressed: this.#autoResumeSuppressed,
      preserveOnly: this.#preserveOnly,
      streaming: this.#host.isStreaming(),
      aborting: this.#host.isAborting(),
      terminalAnswerNoQueuedWork: this.#host.isStreaming() ? false : !this.#host.hasQueuedWork(),
      interruptImmuneTurnActive: interrupting && this.#isImmuneTurnActive(),
    });

    if (DEBUG) {
      console.error(
        `[advisor:debug] route advisor=${sourceName ?? "default"} severity=${severity ?? "nit"} -> channel=${channel} ` +
          `(streaming=${this.#host.isStreaming()} preserveOnly=${this.#preserveOnly} immune=${this.#isImmuneTurnActive()}) note=${JSON.stringify(note.slice(0, 120))}`,
      );
    }

    const noteRecord: AdvisorNote = { note, severity, advisor: sourceName };

    if (channel === "aside") {
      this.#enqueueAside(noteRecord);
      return;
    }
    if (channel === "preserve") {
      const content = formatAdvisorBatchContent([noteRecord]);
      this.#host.sendCustom(content, { notes: [noteRecord] }, { deliverAs: "nextTurn" });
      return;
    }
    // "steer"
    this.#recordInterruptDelivered();
    const content = formatAdvisorBatchContent([noteRecord]);
    this.#host.sendCustom(content, { notes: [noteRecord] }, { deliverAs: "steer", triggerTurn: true });
  }

  #enqueueAside(note: AdvisorNote): void {
    this.#asideQueue.push(note);
    if (this.#asideFlushScheduled) return;
    this.#asideFlushScheduled = true;
    queueMicrotask(() => {
      this.#asideFlushScheduled = false;
      if (this.#asideQueue.length === 0) return;
      const notes = this.#asideQueue;
      this.#asideQueue = [];
      const content = formatAdvisorBatchContent(notes);
      this.#host.sendCustom(content, { notes }, { deliverAs: "steer" });
    });
  }
}

export interface DiscoveredAdvisorsLike {
  advisors: AdvisorConfig[];
  sharedInstructions: string | undefined;
  syncBacklog?: number | "off";
  immuneTurns?: number;
}
