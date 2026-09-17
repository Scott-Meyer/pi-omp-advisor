import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

/** The model lookup contract shared by extension registries and older Pi runtimes. */
export type AdvisorModel = Model<Api>;

export interface AdvisorModelRegistry {
  find?(provider: string, modelId: string): AdvisorModel | undefined;
  getModel?(provider: string, modelId: string): AdvisorModel | undefined;
}

export function findAdvisorModel(
  registry: AdvisorModelRegistry,
  provider: string,
  modelId: string,
): AdvisorModel | undefined {
  return registry.find?.(provider, modelId) ?? registry.getModel?.(provider, modelId);
}

/** OMP's legacy API is a class-backed adapter with these host-owned handles. */
export function isOmpExtensionApi(api: object): boolean {
  return "runtime" in api && "pi" in api;
}

/** Avoid OMP's native advisor renderer while preserving Pi transcript compatibility. */
export function advisorCustomMessageType(api: object): "advisor" | "pi-omp-advisor" {
  return isOmpExtensionApi(api) ? "pi-omp-advisor" : "advisor";
}

/** OMP exposes its newer read-only `models` facade; Pi currently does not. */
export function isOmpHost(ctx: ExtensionContext): boolean {
  return "models" in (ctx as object);
}

/**
 * Recover Pi's live model runtime from the compatibility registry it exposes
 * to extensions. `ModelRegistry` deliberately fronts this same runtime for
 * model lookup/auth/provider registration, but `createAgentSession` needs the
 * runtime itself to preserve session-only `--api-key` credentials and
 * extension-registered providers. There is no public accessor in Pi's current
 * API, so this is capability-checked and callers retain a fresh-runtime
 * fallback for older/different hosts.
 */
export function piHostModelRuntime(ctx: ExtensionContext): ModelRuntime | undefined {
  if (isOmpHost(ctx)) return undefined;
  const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  return runtime && typeof runtime.streamSimple === "function" ? runtime : undefined;
}

/**
 * Discover the same standing context files the host gives its primary session
 * without importing Pi-only convenience exports. Both Pi's loader and OMP's
 * legacy compatibility loader expose this resource contract.
 */
export async function loadAdvisorContextFiles(
  cwd: string,
  agentDir: string,
): Promise<{ path: string; content: string }[]> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  return loader.getAgentsFiles().agentsFiles;
}

/**
 * Pi names the child-session string allowlist `tools`. OMP uses `toolNames` and
 * requires an explicit restriction flag; its `tools` field means Tool objects,
 * so passing Pi's strings there would silently corrupt the child tool set.
 */
export function advisorSessionToolOptions(
  ctx: ExtensionContext,
  toolNames: string[],
  piModelRuntime?: ModelRuntime,
): Record<string, unknown> {
  if (isOmpHost(ctx)) {
    return {
      modelRegistry: ctx.modelRegistry,
      toolNames,
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      // A nested advisor is a closed review runtime, not another project host.
      // Prevent ambient extensions/MCP/LSP/skills from injecting behavior even
      // when their tool names are excluded by the restriction above.
      disableExtensionDiscovery: true,
      enableMCP: false,
      enableLsp: false,
      skills: [],
    };
  }
  return {
    tools: toolNames,
    ...(piModelRuntime ? { modelRuntime: piModelRuntime } : {}),
  };
}

/** Match an actual OMP user submission, including `/skill:` custom prompts. */
export function isOmpUserResumeMessage(message: {
  role: string;
  attribution?: string;
  steering?: boolean;
}): boolean {
  return message.attribution === "user" && message.steering !== true && (message.role === "user" || message.role === "custom");
}

/** Only the latest assistant belongs to OMP's just-completed run; history precedes it. */
export function ompAgentEndWasAborted(messages: readonly { role: string; stopReason?: string }[] | undefined): boolean {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i]!;
    if (message.role === "assistant") return message.stopReason === "aborted";
  }
  return false;
}

/** Disable OMP's built-in watcher inside the extension-owned review session. */
export function disableNestedHostAdvisor(ctx: ExtensionContext, session: unknown): void {
  if (!isOmpHost(ctx)) return;
  const nested = session as { setAdvisorEnabled?: (enabled: boolean) => void; dispose?: () => void };
  if (typeof nested.setAdvisorEnabled !== "function") {
    nested.dispose?.();
    throw new Error("OMP compatibility requires session-local advisor controls.");
  }
  try {
    nested.setAdvisorEnabled(false);
  } catch (err) {
    nested.dispose?.();
    throw err;
  }
}
