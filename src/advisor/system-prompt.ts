/**
 * Assembles one advisor's system prompt from the upstream-derived
 * prompt fragments (npm `@oh-my-pi/pi-coding-agent@17.4.1`,
 * `src/prompts/advisor/*.md`) plus config-driven additions. Ported template
 * substitution from `src/advisor/watchdog.ts`'s `formatActiveRepoWatchdogPrompt`
 * / `formatAdvisorContextPrompt` (simple `{{var}}` / `{{#each}}` substitution,
 * no templating engine dependency needed for these four small templates).
 * See ../../PROVENANCE.md.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PROMPTS_DIR = new URL("../prompts/", import.meta.url);

async function readPrompt(name: string): Promise<string> {
  return fs.readFile(new URL(name, PROMPTS_DIR), "utf8");
}

/** `{{relativeRepoRoot}}` substitution for active-repo-watchdog.md. */
function renderActiveRepoWatchdogPrompt(template: string, relativeRepoRoot: string): string {
  return template.replaceAll("{{relativeRepoRoot}}", () => relativeRepoRoot).trim();
}

/** `{{#each contextFiles}}...{{/each}}` substitution for context-files.md. */
function renderContextFilesPrompt(template: string, contextFiles: readonly { path: string; content: string }[]): string | undefined {
  if (contextFiles.length === 0) return undefined;
  const match = template.match(/\{\{#each contextFiles\}\}([\s\S]*?)\{\{\/each\}\}/);
  if (!match) return template.trim();
  const [whole, itemTemplate] = match;
  const rendered = contextFiles
    .map(file => itemTemplate.replaceAll("{{path}}", () => file.path).replaceAll("{{content}}", () => file.content))
    .join("");
  return template.replace(whole, () => rendered).trim() || undefined;
}

/**
 * If `cwd` is itself outside a git repo but has exactly one direct-child
 * directory that IS a git repo, returns that child's name — matching
 * upstream's `ActiveRepoContext` heuristic (a workspace root one level
 * above the actual project). Best-effort; returns undefined on any error.
 */
async function detectActiveRepoRoot(cwd: string): Promise<string | undefined> {
  const isGitRepo = async (dir: string): Promise<boolean> =>
    fs
      .access(path.join(dir, ".git"))
      .then(() => true)
      .catch(() => false);
  if (await isGitRepo(cwd)) return undefined;
  let entries: string[];
  try {
    entries = (await fs.readdir(cwd, { withFileTypes: true }))
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => e.name);
  } catch {
    return undefined;
  }
  const gitChildren: string[] = [];
  for (const name of entries) {
    if (await isGitRepo(path.join(cwd, name))) gitChildren.push(name);
    if (gitChildren.length > 1) return undefined;
  }
  return gitChildren.length === 1 ? gitChildren[0] : undefined;
}

export interface BuildAdvisorSystemPromptOptions {
  /** WATCHDOG.md `<attention>` blocks from watchdog-config discovery. */
  watchdogBlocks: string[];
  /** Top-level `instructions:` concatenated from every discovered WATCHDOG.yml/.yaml. */
  sharedInstructions: string | undefined;
  /** This advisor's own `instructions:` field. */
  advisorInstructions: string | undefined;
  cwd: string;
  /** Project context files (AGENTS.md etc.), if the caller has them (e.g. `ctx.getSystemPromptOptions().contextFiles`). */
  contextFiles?: readonly { path: string; content: string }[];
}

/**
 * Build one advisor's full system prompt: bundled `system.md`,
 * then (if applicable) the active-repo-watchdog attention block, then
 * project context files, then any discovered `WATCHDOG.md` attention
 * blocks, then shared + per-advisor instructions.
 */
export async function buildAdvisorSystemPrompt(opts: BuildAdvisorSystemPromptOptions): Promise<string> {
  const parts: string[] = [(await readPrompt("system.md")).trim()];

  const activeRepoRoot = await detectActiveRepoRoot(opts.cwd);
  if (activeRepoRoot) {
    const template = await readPrompt("active-repo-watchdog.md");
    parts.push(renderActiveRepoWatchdogPrompt(template, activeRepoRoot));
  }

  if (opts.contextFiles && opts.contextFiles.length > 0) {
    const template = await readPrompt("context-files.md");
    const rendered = renderContextFilesPrompt(template, opts.contextFiles);
    if (rendered) parts.push(rendered);
  }

  for (const block of opts.watchdogBlocks) parts.push(block);

  if (opts.sharedInstructions?.trim()) parts.push(opts.sharedInstructions.trim());
  if (opts.advisorInstructions?.trim()) parts.push(opts.advisorInstructions.trim());

  return parts.join("\n\n");
}
