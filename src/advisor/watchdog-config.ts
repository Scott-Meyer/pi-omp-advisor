/**
 * Ported from oh-my-pi `src/advisor/config.ts` + `src/advisor/watchdog.ts`
 * (npm `@oh-my-pi/pi-coding-agent@17.4.1`): discovery of `WATCHDOG.yml` /
 * `WATCHDOG.yaml` (advisor roster) and `WATCHDOG.md` (freeform attention
 * text) walking from `cwd` up to the repo root (or home), plus the user
 * agent dir, both bare and under a `.omp` subdirectory — kept identical to
 * upstream (filenames AND the `.omp` dotfolder name) per explicit user
 * instruction that config discovery be byte-for-byte compatible, not just
 * the file names. Bun-specific I/O (`Bun.file`, `Bun.YAML`) is replaced with
 * `node:fs` + the `yaml` npm package; git-root resolution is a plain
 * `git rev-parse --show-toplevel` shellout instead of omp's internal `repo`
 * helper. See ../../PROVENANCE.md.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
/**
 * `yaml` is a genuine third-party dependency (declared in this package's
 * `dependencies`) — unlike `typebox` and the `@earendil-works/*` packages, pi
 * does NOT provide it to extensions (see pi's `docs/packages.md`, whose
 * host-provided list is pi-ai, pi-agent-core, pi-coding-agent, pi-tui,
 * typebox). A statically-imported bare `yaml` therefore only resolves when it
 * happens to be hoisted into the agent's shared `node_modules` by some
 * unrelated package, which varies per machine and install order.
 *
 * It is loaded dynamically and guarded so that an unresolvable `yaml` degrades
 * to "no YAML roster discovered" instead of throwing at extension load — an
 * extension that throws while loading takes down the entire pi session, so a
 * missing optional-at-runtime dependency must never be a hard failure.
 * Freeform `WATCHDOG.md` instructions need no parser and keep working.
 */
interface YamlModule {
  parse: (source: string) => unknown;
  stringify: (value: unknown) => string;
}

let yamlModule: YamlModule | null | undefined;

async function requireYaml(): Promise<YamlModule | null> {
  if (yamlModule !== undefined) return yamlModule;
  try {
    const mod = (await import("yaml")) as unknown as YamlModule & { default?: YamlModule };
    yamlModule = mod.default?.parse ? mod.default : mod;
  } catch (err) {
    yamlModule = null;
    console.error(
      `[pi-omp-advisor] cannot load the 'yaml' package, so WATCHDOG.yml/.yaml files will be ignored ` +
        `(WATCHDOG.md still works). Install pi-omp-advisor as a pi package so its dependencies are ` +
        `installed with it, rather than symlinking its source directory. Cause: ${String(err)}`,
    );
  }
  return yamlModule;
}
import { ADVISOR_TOOL_NAME_ALIASES } from "./advise-logic.ts";
import { MIN_ADVISOR_CONTEXT_TOKENS } from "./context-window.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_BEHIND = 3;
export const DEFAULT_FLUSH_TIMEOUT_MS = 4 * 60_000;
export const DEFAULT_FLUSH_ON_SETTLED = true;

export interface AdvisorConfig {
  name: string;
  model?: string;
  tools?: string[];
  instructions?: string;
  /** Per-advisor on/off toggle (default `true`). */
  enabled?: boolean;
  /** Estimated total model-input budget; defaults to 32,000 tokens. */
  contextTokens?: number;
  /** Include the primary's reasoning in observations; defaults to false. */
  includePrimaryThinking?: boolean;
  /** Completed delta-bearing primary turns per advisor wake (default 3, min 1). */
  maxBehind?: number;
  /** Maximum age of the oldest accumulated turn in milliseconds (default 240000, min 100). */
  flushTimeoutMs?: number;
  /** Deliver pending observations when the primary settles instead of waiting for the full turn batch (default true). */
  flushOnSettled?: boolean;
}

export interface SyncBacklogThresholds {
  pauseAt: number;
  resumeAt: number;
}

export type SyncBacklogConfig = number | "off" | SyncBacklogThresholds;

/**
 * Normalizes any valid syncBacklog setting into explicit { pauseAt, resumeAt }
 * thresholds, or undefined if syncBacklog is off / unset / invalid.
 */
export function normalizeSyncBacklog(setting: unknown): SyncBacklogThresholds | undefined {
  if (setting === "off" || setting === false || setting === undefined || setting === null) {
    return undefined;
  }
  if (typeof setting === "number" && Number.isFinite(setting) && setting > 0) {
    const pauseAt = Math.floor(setting);
    return { pauseAt, resumeAt: Math.max(0, pauseAt - 1) };
  }
  if (typeof setting === "string") {
    const parsed = Number.parseInt(setting, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { pauseAt: parsed, resumeAt: Math.max(0, parsed - 1) };
    }
    return undefined;
  }
  if (typeof setting === "object" && setting !== null) {
    const obj = setting as Record<string, unknown>;
    const rawPause = typeof obj.pauseAt === "number"
      ? obj.pauseAt
      : typeof obj.maxBehind === "number"
      ? obj.maxBehind
      : undefined;
    const rawResume = typeof obj.resumeAt === "number"
      ? obj.resumeAt
      : typeof obj.drainTo === "number"
      ? obj.drainTo
      : undefined;
    if (rawPause !== undefined && Number.isFinite(rawPause) && rawPause > 0) {
      const pauseAt = Math.floor(rawPause);
      const resumeAt = rawResume !== undefined && Number.isFinite(rawResume) && rawResume >= 0
        ? Math.min(pauseAt - 1, Math.floor(rawResume))
        : Math.max(0, pauseAt - 1);
      return { pauseAt, resumeAt };
    }
  }
  return undefined;
}

export interface DiscoveredAdvisors {
  advisors: AdvisorConfig[];
  sharedInstructions: string | undefined;
  /**
   * pi-omp-advisor-specific addition, not part of upstream's `WATCHDOG.yml` schema
   * (upstream has no concept of a separate subagent process to gate — it
   * IS the whole product, always on). Top-level `subagents: true|false` in
   * any discovered `WATCHDOG.yml`/`.yaml`; `true` from a more specific file
   * wins over `false` from a less specific one, same precedence as
   * `instructions`. `undefined` when no file sets it explicitly (caller
   * default: off in a subagent process).
   */
  subagentsEnabled: boolean | undefined;
  /**
   * pi-omp-advisor-specific addition. Top-level `main: true|false` — the
   * persisted default for whether a MAIN (non-subagent) session watches
   * itself, independent of whether an advisor roster is present. Lets a
   * roster stay configured (e.g. for subagent use only, via `subagents:
   * true`) while the main session itself defaults off. `undefined` when no
   * file sets it explicitly (caller default: on, with an implicit advisor if
   * no roster exists).
   */
  mainEnabled: boolean | undefined;
  /**
   * Upstream's `advisor.syncBacklog` setting (`off` | `1` | `3` | `5` or `{ pauseAt, resumeAt }`),
   * expressed here as a `WATCHDOG.yml` field because pi has no equivalent
   * settings-schema surface to register into. Pause the primary for up to 30s
   * when an advisor is behind; `"off"` disables catch-up delays entirely.
   * Upstream's default is `"off"`. Supports hysteresis: pause at X queued turns, resume at Y.
   */
  syncBacklog: SyncBacklogConfig | undefined;
  /**
   * Upstream's `advisor.immuneTurns` setting (default `3`). After a concern or
   * blocker interrupts, route further **concerns** non-interruptingly for this
   * many primary turns. Blockers are deliberately exempt and keep interrupting
   * — see `resolveAdvisorDeliveryChannel`, which only downgrades when
   * `severity !== "blocker"`. `undefined` means upstream's default.
   */
  immuneTurns: number | undefined;
  /** Completed delta-bearing primary turns per advisor wake (default 3). */
  maxBehind: number | undefined;
  /** Maximum age of the oldest accumulated turn (default 240000ms). */
  flushTimeoutMs: number | undefined;
  /** Deliver pending observations at primary settlement instead of waiting for the turn batch (default true; set false for strict turn batching). */
  flushOnSettled: boolean | undefined;
  /**
   * Whether at least one `WATCHDOG.yml`/`.yaml` was found and parsed into a
   * valid mapping, even if it declares no advisors. Activation no longer
   * depends on this flag—normal sessions have an implicit default—but callers
   * still use it to distinguish configured and implicit rosters.
   */
  configFound: boolean;
}

/**
 * Normalize an advisor name into a filesystem-/id-safe slug: lowercase,
 * non-alphanumerics collapsed to `-`, leading/trailing `-` trimmed. Falls
 * back to `"advisor"` when nothing survives; callers dedupe collisions.
 */
export function slugifyAdvisorName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "advisor";
}

async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

export interface ConfigCandidate {
  path: string;
  content: string;
  level: "user" | "project";
  depth: number;
}

/**
 * Walk the watchdog/advisor config search path — the user agent dir plus
 * every directory from `cwd` up to the repo root (or home), probing both
 * `<F>` and `.omp/<F>` for each given filename — and return the
 * readable candidates with their raw content, sorted user-first then
 * project ancestor→leaf (depth descending, so the leaf directory is
 * most specific/last). Content is returned verbatim; callers expand what
 * they need.
 */
export async function collectConfigCandidates(
  cwd: string,
  agentDir: string | undefined,
  filenames: string[],
): Promise<ConfigCandidate[]> {
  const home = os.homedir();
  const resolvedAgentDir = agentDir;
  const userPaths = new Set<string>();
  const repoRoot = await gitRoot(cwd);

  const candidates = new Set<string>();

  if (resolvedAgentDir) {
    for (const filename of filenames) {
      const userPath = path.resolve(resolvedAgentDir, filename);
      candidates.add(userPath);
      userPaths.add(userPath);
    }
  }

  let current = cwd;
  while (true) {
    for (const filename of filenames) {
      candidates.add(path.resolve(current, ".omp", filename));
      candidates.add(path.resolve(current, filename));
    }
    if (current === (repoRoot ?? home)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const items: ConfigCandidate[] = [];
  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf8");
      const parent = path.dirname(candidate);
      const baseName = parent.split(path.sep).pop() ?? "";
      const isUser = userPaths.has(candidate);
      const ownerDir = baseName === ".omp" ? path.dirname(parent) : parent;
      const ownerBaseName = ownerDir.split(path.sep).pop() ?? "";
      if (isUser || !ownerBaseName.startsWith(".") || baseName === ".omp") {
        const relative = path.relative(cwd, ownerDir);
        const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
        items.push({ path: candidate, content, level: isUser ? "user" : "project", depth });
      }
    } catch (err) {
      if (!isEnoent(err)) {
        console.error(`[pi-omp-advisor] failed to read config candidate ${candidate}: ${String(err)}`);
      }
    }
  }

  items.sort((a, b) => {
    if (a.level !== b.level) return a.level === "user" ? -1 : 1;
    return b.depth - a.depth;
  });

  return items;
}

/**
 * Discover and load WATCHDOG.md files walking up from cwd, project
 * `.omp` folder, and user agent dir. Returns formatted blocks ready to
 * be appended to the advisor system prompt.
 */
export async function discoverWatchdogFiles(cwd: string, agentDir?: string): Promise<string[]> {
  const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.md"]);
  return items.map(item => `Especially pay attention to:\n<attention>\n${item.content.trim()}\n</attention>`);
}

/** Known advisor tool grants, validated at config-parse time. */
const KNOWN_TOOL_NAMES = new Set<string>([
  "read",
  "grep",
  "find",
  "glob",
  "ls",
  "edit",
  "write",
  "bash",
  "advise",
  "request_stop",
]);

function normalizeToolNames(tools: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tools) {
    const name = ADVISOR_TOOL_NAME_ALIASES.get(raw) ?? raw;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function filterAdvisorTools(tools: string[] | undefined, sourcePath: string): string[] | undefined {
  if (tools === undefined) return undefined;
  if (tools.length === 0) return [];
  const filtered = normalizeToolNames(tools).filter(name => {
    if (KNOWN_TOOL_NAMES.has(name)) return true;
    console.error(`[pi-omp-advisor] advisor config ${sourcePath}: dropping unknown tool "${name}"`);
    return false;
  });
  return filtered.length > 0 ? filtered : undefined;
}

interface WatchdogYamlAdvisorEntry {
  name?: unknown;
  model?: unknown;
  tools?: unknown;
  instructions?: unknown;
  enabled?: unknown;
  contextTokens?: unknown;
  includePrimaryThinking?: unknown;
  maxBehind?: unknown;
  flushTimeoutMs?: unknown;
  flushOnSettled?: unknown;
}
interface WatchdogYamlDoc {
  instructions?: unknown;
  advisors?: unknown;
  /** pi-omp-advisor-specific; see {@link DiscoveredAdvisors.subagentsEnabled}. */
  subagents?: unknown;
  syncBacklog?: unknown;
  immuneTurns?: unknown;
  /** pi-omp-advisor-specific; see {@link DiscoveredAdvisors.mainEnabled}. */
  main?: unknown;
  maxBehind?: unknown;
  flushTimeoutMs?: unknown;
  flushOnSettled?: unknown;
}

function validateAdvisorEntry(entry: WatchdogYamlAdvisorEntry, sourcePath: string): AdvisorConfig | undefined {
  if (typeof entry.name !== "string" || !entry.name.trim()) {
    console.error(`[pi-omp-advisor] advisor config ${sourcePath}: skipping advisor entry with missing/invalid "name"`);
    return undefined;
  }
  const out: AdvisorConfig = {
    name: entry.name,
  };
  if (typeof entry.model === "string" && entry.model.trim()) out.model = entry.model;
  if (Array.isArray(entry.tools) && entry.tools.every(t => typeof t === "string")) out.tools = entry.tools as string[];
  if (typeof entry.instructions === "string" && entry.instructions.trim()) out.instructions = entry.instructions;
  if (typeof entry.enabled === "boolean") out.enabled = entry.enabled;
  if (entry.contextTokens !== undefined) {
    if (typeof entry.contextTokens !== "number" || !Number.isSafeInteger(entry.contextTokens) || entry.contextTokens < MIN_ADVISOR_CONTEXT_TOKENS) {
      throw new WatchdogConfigUnreadableError(sourcePath, `advisor "${entry.name}" contextTokens must be an integer of at least ${MIN_ADVISOR_CONTEXT_TOKENS}`);
    }
    out.contextTokens = entry.contextTokens;
  }
  if (entry.includePrimaryThinking !== undefined) {
    if (typeof entry.includePrimaryThinking !== "boolean") {
      throw new WatchdogConfigUnreadableError(sourcePath, `advisor "${entry.name}" includePrimaryThinking must be true or false`);
    }
    out.includePrimaryThinking = entry.includePrimaryThinking;
  }
  if (entry.maxBehind !== undefined) {
    if (typeof entry.maxBehind !== "number" || !Number.isSafeInteger(entry.maxBehind) || entry.maxBehind < 1) {
      throw new WatchdogConfigUnreadableError(sourcePath, `advisor "${entry.name}" maxBehind must be an integer >= 1`);
    }
    out.maxBehind = entry.maxBehind;
  }
  if (entry.flushTimeoutMs !== undefined) {
    if (typeof entry.flushTimeoutMs !== "number" || !Number.isSafeInteger(entry.flushTimeoutMs) || entry.flushTimeoutMs < 100) {
      throw new WatchdogConfigUnreadableError(sourcePath, `advisor "${entry.name}" flushTimeoutMs must be an integer >= 100`);
    }
    out.flushTimeoutMs = entry.flushTimeoutMs;
  }
  if (entry.flushOnSettled !== undefined) {
    if (typeof entry.flushOnSettled !== "boolean") {
      throw new WatchdogConfigUnreadableError(sourcePath, `advisor "${entry.name}" flushOnSettled must be true or false`);
    }
    out.flushOnSettled = entry.flushOnSettled;
  }
  return out;
}

/**
 * Discover advisor configs from `WATCHDOG.yml`/`WATCHDOG.yaml` files on the
 * same search path as `WATCHDOG.md`. Advisors are keyed by slug; a
 * more-specific file (project leaf > project ancestor > user) replaces an
 * earlier entry with the same slug. Top-level `instructions` across all
 * files concatenate into the shared baseline. `excludePaths` can omit a
 * specific file to inspect what it would inherit without that override.
 * A malformed file is logged and skipped — never thrown.
 */
export async function discoverAdvisorConfigs(
  cwd: string,
  agentDir?: string,
  options?: { excludePaths?: readonly string[] },
): Promise<DiscoveredAdvisors> {
  const excluded = new Set(options?.excludePaths?.map(p => path.resolve(p)) ?? []);
  const items = (await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.yml", "WATCHDOG.yaml"]))
    .filter(item => !excluded.has(path.resolve(item.path)));
  const advisors = new Map<string, AdvisorConfig>();
  const sharedParts: string[] = [];
  let subagentsEnabled: boolean | undefined;
  let mainEnabled: boolean | undefined;
  let syncBacklog: SyncBacklogConfig | undefined;
  let immuneTurns: number | undefined;
  let maxBehind: number | undefined;
  let flushTimeoutMs: number | undefined;
  let flushOnSettled: boolean | undefined;
  let parsedAnyConfig = false;

  const yaml = items.length > 0 ? await requireYaml() : null;
  for (const item of items) {
    if (!yaml) break;
    let parsed: unknown;
    try {
      parsed = yaml.parse(item.content);
    } catch (err) {
      console.error(`[pi-omp-advisor] advisor config: failed to parse YAML at ${item.path}: ${String(err)}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error(`[pi-omp-advisor] advisor config: expected a YAML mapping at ${item.path}`);
      continue;
    }
    const doc = parsed as WatchdogYamlDoc;

    if (typeof doc.instructions === "string" && doc.instructions.trim()) {
      sharedParts.push(doc.instructions.trim());
    }
    if (typeof doc.subagents === "boolean") subagentsEnabled = doc.subagents;
    if (typeof doc.main === "boolean") mainEnabled = doc.main;
    if (doc.syncBacklog === "off" || doc.syncBacklog === false) {
      syncBacklog = "off";
    } else if (typeof doc.syncBacklog === "number" && Number.isFinite(doc.syncBacklog) && doc.syncBacklog > 0) {
      syncBacklog = Math.floor(doc.syncBacklog);
    } else if (typeof doc.syncBacklog === "string") {
      const parsed = Number.parseInt(doc.syncBacklog, 10);
      if (Number.isFinite(parsed) && parsed > 0) syncBacklog = parsed;
      else console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "syncBacklog" (expected off, number, or { pauseAt, resumeAt })`);
    } else if (typeof doc.syncBacklog === "object" && doc.syncBacklog !== null) {
      const thresholds = normalizeSyncBacklog(doc.syncBacklog);
      if (thresholds) syncBacklog = thresholds;
      else console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "syncBacklog" object (expected { pauseAt: number, resumeAt: number })`);
    } else if (doc.syncBacklog !== undefined) {
      console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "syncBacklog" (expected off, number, or { pauseAt, resumeAt })`);
    }
    parsedAnyConfig = true;
    if (typeof doc.immuneTurns === "number" && Number.isFinite(doc.immuneTurns) && doc.immuneTurns >= 0) {
      immuneTurns = Math.floor(doc.immuneTurns);
    } else if (doc.immuneTurns !== undefined) {
      console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "immuneTurns" (expected a non-negative number)`);
    }
    if (typeof doc.maxBehind === "number" && Number.isSafeInteger(doc.maxBehind) && doc.maxBehind >= 1) {
      maxBehind = doc.maxBehind;
    } else if (doc.maxBehind !== undefined) {
      console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "maxBehind" (expected an integer >= 1)`);
    }
    if (typeof doc.flushTimeoutMs === "number" && Number.isSafeInteger(doc.flushTimeoutMs) && doc.flushTimeoutMs >= 100) {
      flushTimeoutMs = doc.flushTimeoutMs;
    } else if (doc.flushTimeoutMs !== undefined) {
      console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "flushTimeoutMs" (expected an integer >= 100)`);
    }
    if (typeof doc.flushOnSettled === "boolean") {
      flushOnSettled = doc.flushOnSettled;
    } else if (doc.flushOnSettled !== undefined) {
      console.error(`[pi-omp-advisor] advisor config ${item.path}: ignoring invalid "flushOnSettled" (expected true or false)`);
    }

    if (Array.isArray(doc.advisors)) {
      for (const raw of doc.advisors) {
        if (!raw || typeof raw !== "object") continue;
        let entry: AdvisorConfig | undefined;
        try {
          entry = validateAdvisorEntry(raw as WatchdogYamlAdvisorEntry, item.path);
        } catch (error) {
          console.error(`[pi-omp-advisor] ${String(error)}; advisor disabled`);
          const name = (raw as WatchdogYamlAdvisorEntry).name;
          // Keep an invalid explicit roster entry disabled instead of falling
          // through to an implicit default advisor with a larger memory budget.
          if (typeof name === "string" && name.trim()) advisors.set(slugifyAdvisorName(name), { name, enabled: false });
          continue;
        }
        if (!entry) continue;
        const slug = slugifyAdvisorName(entry.name);
        advisors.set(slug, {
          name: entry.name,
          model: entry.model,
          tools: filterAdvisorTools(entry.tools, item.path),
          instructions: entry.instructions,
          enabled: entry.enabled,
          contextTokens: entry.contextTokens,
          includePrimaryThinking: entry.includePrimaryThinking,
          maxBehind: entry.maxBehind ?? maxBehind,
          flushTimeoutMs: entry.flushTimeoutMs ?? flushTimeoutMs,
          flushOnSettled: entry.flushOnSettled ?? flushOnSettled,
        });
      }
    }
  }

  return {
    advisors: [...advisors.values()],
    sharedInstructions: sharedParts.length > 0 ? sharedParts.join("\n\n") : undefined,
    subagentsEnabled,
    mainEnabled,
    syncBacklog,
    immuneTurns,
    maxBehind,
    flushTimeoutMs,
    flushOnSettled,
    configFound: parsedAnyConfig,
  };
}

/**
 * Thrown by {@link loadWatchdogConfigFile} when an existing config file cannot be
 * read or parsed. Callers that persist the returned document MUST let this
 * propagate rather than saving a blank document over the user's file.
 */
export class WatchdogConfigUnreadableError extends Error {
  constructor(
    readonly filePath: string,
    readonly detail: string,
  ) {
    super(`cannot read ${filePath}: ${detail}. Fix or move the file, then retry — refusing to overwrite it.`);
    this.name = "WatchdogConfigUnreadableError";
  }
}

export type AdvisorConfigScope = "project" | "user";

export interface WatchdogConfigDoc {
  instructions?: string;
  advisors: AdvisorConfig[];
  /** pi-omp-advisor-specific; see {@link DiscoveredAdvisors.subagentsEnabled}. */
  subagents?: boolean;
  /** pi-omp-advisor-specific; see {@link DiscoveredAdvisors.mainEnabled}. */
  main?: boolean;
  /** See {@link DiscoveredAdvisors.syncBacklog}. */
  syncBacklog?: SyncBacklogConfig;
  /** See {@link DiscoveredAdvisors.immuneTurns}. */
  immuneTurns?: number;
  /** Completed delta-bearing primary turns per advisor wake (default 3, min 1). */
  maxBehind?: number;
  /** Maximum age of the oldest accumulated turn (default 240000ms, min 100). */
  flushTimeoutMs?: number;
  /** Deliver pending observations at primary settlement instead of waiting for the turn batch (default true). */
  flushOnSettled?: boolean;
}

export function advisorConfigFilePath(scope: AdvisorConfigScope, dirs: { projectDir: string; agentDir: string }): string {
  return path.join(scope === "user" ? dirs.agentDir : dirs.projectDir, "WATCHDOG.yml");
}

export async function resolveAdvisorConfigEditPath(
  scope: AdvisorConfigScope,
  dirs: { projectDir: string; agentDir: string },
): Promise<string> {
  const dir = scope === "user" ? dirs.agentDir : dirs.projectDir;
  const yml = path.join(dir, "WATCHDOG.yml");
  const yaml = path.join(dir, "WATCHDOG.yaml");
  const ymlExists = await fs
    .access(yml)
    .then(() => true)
    .catch(() => false);
  const yamlExists = await fs
    .access(yaml)
    .then(() => true)
    .catch(() => false);
  if (!ymlExists && yamlExists) return yaml;
  return yml;
}

export async function loadWatchdogConfigFile(filePath: string): Promise<WatchdogConfigDoc> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    // A genuinely absent file is the "create new config" case. Any other read
    // error (permissions, I/O) must not masquerade as an empty document that a
    // caller then writes back over the real file.
    if (isEnoent(err)) return { advisors: [] };
    throw new WatchdogConfigUnreadableError(filePath, String(err));
  }
  const yaml = await requireYaml();
  if (!yaml) throw new WatchdogConfigUnreadableError(filePath, "the 'yaml' package is not resolvable");
  let parsed: unknown;
  try {
    parsed = yaml.parse(text);
  } catch (err) {
    // Must NOT return an empty document: callers save what this returns, so
    // treating an unparseable file as "empty" turns a syntax error into silent
    // destruction of the user's whole config. A missing file is different — that
    // legitimately starts from empty (handled above).
    throw new WatchdogConfigUnreadableError(filePath, String(err));
  }
  // A blank or comment-only file parses to null/undefined — that is legitimately
  // an empty document to start editing from. Anything else that is not a mapping
  // (a sequence, a bare scalar) is a file whose meaning we do not understand, and
  // returning an empty document for it would let the caller save over real
  // content. Refuse, exactly as for a syntax error.
  if (parsed === null || parsed === undefined) return { advisors: [] };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WatchdogConfigUnreadableError(
      filePath,
      `expected a YAML mapping at the document root, found ${Array.isArray(parsed) ? "a sequence" : typeof parsed}`,
    );
  }
  const doc = parsed as WatchdogYamlDoc;
  const advisors: AdvisorConfig[] = [];
  if (Array.isArray(doc.advisors)) {
    for (const raw of doc.advisors) {
      if (!raw || typeof raw !== "object") continue;
      const entry = validateAdvisorEntry(raw as WatchdogYamlAdvisorEntry, filePath);
      if (entry) advisors.push(entry);
    }
  }
  const result: WatchdogConfigDoc = { advisors };
  if (typeof doc.instructions === "string" && doc.instructions.trim()) result.instructions = doc.instructions;
  if (typeof doc.subagents === "boolean") result.subagents = doc.subagents;
  if (typeof doc.main === "boolean") result.main = doc.main;
  // EVERY field `serializeWatchdogConfig` writes must be read back here, or an
  // edit round-trip silently deletes it: the editable doc is what gets saved, so
  // a field this loader drops is a field `/advisor config` or `/advisor main
  // on|off` erases from the user's file.
  if (doc.syncBacklog === "off") {
    result.syncBacklog = "off";
  } else if (typeof doc.syncBacklog === "number" && Number.isFinite(doc.syncBacklog) && doc.syncBacklog > 0) {
    result.syncBacklog = Math.floor(doc.syncBacklog);
  } else if (typeof doc.syncBacklog === "string") {
    const parsed = Number.parseInt(doc.syncBacklog, 10);
    if (Number.isFinite(parsed) && parsed > 0) result.syncBacklog = parsed;
  } else if (typeof doc.syncBacklog === "object" && doc.syncBacklog !== null) {
    const thresholds = normalizeSyncBacklog(doc.syncBacklog);
    if (thresholds) result.syncBacklog = thresholds;
  }
  if (typeof doc.immuneTurns === "number" && Number.isFinite(doc.immuneTurns) && doc.immuneTurns >= 0) {
    result.immuneTurns = Math.floor(doc.immuneTurns);
  }
  if (typeof doc.maxBehind === "number" && Number.isSafeInteger(doc.maxBehind) && doc.maxBehind >= 1) {
    result.maxBehind = doc.maxBehind;
  }
  if (typeof doc.flushTimeoutMs === "number" && Number.isSafeInteger(doc.flushTimeoutMs) && doc.flushTimeoutMs >= 100) {
    result.flushTimeoutMs = doc.flushTimeoutMs;
  }
  if (typeof doc.flushOnSettled === "boolean") result.flushOnSettled = doc.flushOnSettled;
  return result;
}

export async function serializeWatchdogConfig(doc: WatchdogConfigDoc): Promise<string> {
  const yaml = await requireYaml();
  if (!yaml) {
    throw new Error(
      "cannot write WATCHDOG.yml: the 'yaml' package is not resolvable from this install of pi-omp-advisor. " +
        "Install pi-omp-advisor as a pi package (so its dependencies install with it) instead of symlinking its source directory.",
    );
  }
  const plain: Record<string, unknown> = {};
  if (doc.instructions?.trim()) plain.instructions = doc.instructions;
  if (doc.subagents !== undefined) plain.subagents = doc.subagents;
  if (doc.main !== undefined) plain.main = doc.main;
  if (doc.syncBacklog !== undefined) {
    if (typeof doc.syncBacklog === "object" && doc.syncBacklog !== null) {
      plain.syncBacklog = { pauseAt: doc.syncBacklog.pauseAt, resumeAt: doc.syncBacklog.resumeAt };
    } else {
      plain.syncBacklog = doc.syncBacklog;
    }
  }
  if (doc.immuneTurns !== undefined) plain.immuneTurns = doc.immuneTurns;
  if (doc.maxBehind !== undefined) plain.maxBehind = doc.maxBehind;
  if (doc.flushTimeoutMs !== undefined) plain.flushTimeoutMs = doc.flushTimeoutMs;
  if (doc.flushOnSettled !== undefined) plain.flushOnSettled = doc.flushOnSettled;

  if (doc.advisors.length > 0) {
    plain.advisors = doc.advisors.map(a => {
      const entry: Record<string, unknown> = { name: a.name };
      if (a.model?.trim()) entry.model = a.model;
      if (a.tools !== undefined) entry.tools = a.tools;
      if (a.instructions?.trim()) entry.instructions = a.instructions;
      if (a.enabled !== undefined) entry.enabled = a.enabled;
      if (a.contextTokens !== undefined) entry.contextTokens = a.contextTokens;
      if (a.includePrimaryThinking !== undefined) entry.includePrimaryThinking = a.includePrimaryThinking;
      if (a.maxBehind !== undefined) entry.maxBehind = a.maxBehind;
      if (a.flushTimeoutMs !== undefined) entry.flushTimeoutMs = a.flushTimeoutMs;
      if (a.flushOnSettled !== undefined) entry.flushOnSettled = a.flushOnSettled;
      return entry;
    });
  }
  if (Object.keys(plain).length === 0) return "";
  return yaml.stringify(plain);
}

export async function saveWatchdogConfigFile(filePath: string, doc: WatchdogConfigDoc): Promise<void> {
  const content = await serializeWatchdogConfig(doc);
  if (!content.trim()) {
    try {
      await fs.rm(filePath, { force: true });
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}
