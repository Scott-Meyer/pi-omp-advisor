/**
 * Settings for the advisor's own review sessions: the person's current Pi
 * settings, read once, with Pi's prompt-cache warming off.
 *
 * The advisor drives each review session's Agent directly rather than through
 * AgentSession.prompt(), so Pi never sees those runs settle. Its cache warmer
 * would then keep sending keep-alive model requests for up to an hour after
 * every review, even while Pi is idle. Nothing here is written back: the
 * primary session's own settings, and the person's files, are untouched.
 *
 * Hosts without these settings APIs (OMP, older Pi) get undefined and keep
 * their default behavior.
 */
import * as pi from "@earendil-works/pi-coding-agent";

type Scope = "global" | "project";
interface SettingsManagerLike {
  getGlobalSettings(): Record<string, unknown>;
  getProjectSettings(): Record<string, unknown>;
  isProjectTrusted?(): boolean;
}
interface SettingsManagerStatics {
  create(cwd: string, agentDir?: string): SettingsManagerLike;
  fromStorage(storage: { withLock(scope: Scope, fn: (current: string | undefined) => string | undefined): void }, options?: { projectTrusted?: boolean }): unknown;
}

export function advisorSettingsManager(cwd: string, agentDir?: string): unknown {
  const SettingsManager = (pi as unknown as { SettingsManager?: Partial<SettingsManagerStatics> }).SettingsManager;
  if (typeof SettingsManager?.create !== "function" || typeof SettingsManager.fromStorage !== "function") return undefined;
  try {
    const source = SettingsManager.create(cwd, agentDir);
    const snapshot: Record<Scope, string> = {
      global: JSON.stringify({ ...source.getGlobalSettings(), cacheWarming: "off" }),
      project: JSON.stringify(source.getProjectSettings()),
    };
    return SettingsManager.fromStorage(
      // Reads see the snapshot; anything a session tries to save is dropped.
      { withLock: (scope, fn) => { fn(snapshot[scope]); } },
      { projectTrusted: source.isProjectTrusted?.() ?? false },
    );
  } catch {
    return undefined;
  }
}
