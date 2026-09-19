import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import {
  discoverAdvisorConfigs,
  loadWatchdogConfigFile,
  saveWatchdogConfigFile,
  type WatchdogConfigDoc,
} from "./advisor/watchdog-config.ts";
import initAdvisorExtension, {
  applyAdvisorModelSelection,
  cleanModelId,
  formatAdvisorStatusBar,
  formatEconomySummary,
  getAdvisorArgumentCompletions,
} from "./index.ts";

test("offers documented advisor subcommands with descriptions", () => {
  const completions = getAdvisorArgumentCompletions("");

  assert.ok(completions);
  assert.deepEqual(
    completions.map(item => item.value),
    [
      "menu",
      "status",
      "inbox",
      "stream",
      "queue",
      "pause",
      "resume",
      "clear",
      "on",
      "off",
      "config",
      "main on",
      "main off",
      "subagents on",
      "subagents off",
      "help",
    ],
  );
  assert.ok(completions.every(item => item.description));
});

test("filters advisor completions without producing malformed tab replacements", () => {
  assert.deepEqual(getAdvisorArgumentCompletions("pau")?.map(item => item.value), ["pause"]);
  assert.deepEqual(getAdvisorArgumentCompletions("main ")?.map(item => item.value), ["main on", "main off"]);
  assert.deepEqual(getAdvisorArgumentCompletions("  subagents o")?.map(item => item.value), ["subagents on", "subagents off"]);
  assert.equal(getAdvisorArgumentCompletions("not-a-command"), null);
});

test("integrates with Pi's argument provider and replaces only the subcommand prefix", async () => {
  const provider = new CombinedAutocompleteProvider(
    [
      {
        name: "advisor",
        getArgumentCompletions: getAdvisorArgumentCompletions,
      },
    ],
    process.cwd(),
  );
  const input = "/advisor pau";
  const suggestions = await provider.getSuggestions([input], 0, input.length, {
    signal: new AbortController().signal,
    force: false,
  });

  assert.ok(suggestions);
  assert.equal(suggestions.prefix, "pau");
  assert.deepEqual(suggestions.items.map(item => item.value), ["pause"]);
  assert.deepEqual(provider.applyCompletion([input], 0, input.length, suggestions.items[0]!, suggestions.prefix), {
    lines: ["/advisor pause"],
    cursorLine: 0,
    cursorCol: "/advisor pause".length,
  });
});

test("cleanModelId extracts readable model id from complex provider paths", () => {
  assert.equal(cleanModelId("ai-gw-openai/openai/gpt-6-astra"), "gpt-6-astra");
  assert.equal(cleanModelId("ai-gw-anthropic/anthropic/claude-3-7-sonnet"), "claude-3-7-sonnet");
  assert.equal(cleanModelId("openai/gpt-4o"), "gpt-4o");
  assert.equal(cleanModelId("anthropic/claude-3-5-sonnet"), "claude-3-5-sonnet");
  assert.equal(cleanModelId("ollama/llama3.2:latest"), "llama3.2:latest");
  assert.equal(cleanModelId("bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0"), "us.anthropic.claude-3-5-sonnet-20241022-v2:0");
  assert.equal(cleanModelId("simple-id"), "simple-id");
  assert.equal(cleanModelId(""), undefined);
  assert.equal(cleanModelId("   "), undefined);
  assert.equal(cleanModelId(undefined), undefined);
});

test("formatAdvisorStatusBar formats clear, concise status lines across all states", () => {
  // Off state
  assert.equal(
    formatAdvisorStatusBar({ runtimeEnabled: false, paused: false }),
    "advisor: OFF",
  );

  // Starting state
  assert.equal(
    formatAdvisorStatusBar({ runtimeEnabled: true, paused: false, starting: true }),
    "advisor: starting…",
  );

  // Settled empty/disabled roster (startup completed but no active advisors)
  assert.equal(
    formatAdvisorStatusBar({ runtimeEnabled: true, paused: false, starting: false, advisors: [] }),
    "advisor: OFF",
  );

  // Single default advisor running
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [{ name: "default", model: "ai-gw-openai/openai/gpt-6-astra", status: "running" }],
    }),
    "advisor: gpt-6-astra ON",
  );

  // Single advisor named "advisor" running
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [{ name: "advisor", model: "openai/gpt-4o", status: "running" }],
    }),
    "advisor: gpt-4o ON",
  );

  // Single named specialist running
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [{ name: "security", model: "anthropic/claude-3-5-sonnet", status: "running" }],
    }),
    "advisor: security · claude-3-5-sonnet ON",
  );

  // Paused single advisor with queued notes
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: true,
      queuedCount: 2,
      advisors: [{ name: "default", model: "openai/gpt-6-astra", status: "paused" }],
    }),
    "advisor: gpt-6-astra PAUSED · 2 queued",
  );

  // Multiple running advisors
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [
        { name: "default", model: "openai/gpt-6-astra", status: "running" },
        { name: "security", model: "anthropic/claude-3-5-sonnet", status: "running" },
      ],
    }),
    "advisors: 2 active ON",
  );

  // Multiple paused advisors
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: true,
      queuedCount: 3,
      advisors: [
        { name: "default", model: "openai/gpt-6-astra", status: "paused" },
        { name: "security", model: "anthropic/claude-3-5-sonnet", status: "paused" },
      ],
    }),
    "advisors: 2 PAUSED · 3 queued",
  );

  // Mixed roster: 1 running, 1 unresolved no_model -> accurately counts 1 active!
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [
        { name: "default", model: "openai/gpt-6-astra", status: "running" },
        { name: "broken", model: "invalid-provider/model", status: "no_model" },
      ],
    }),
    "advisor: gpt-6-astra ON",
  );

  // All configured advisors failed to resolve model
  assert.equal(
    formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [{ name: "default", model: "invalid/model", status: "no_model" }],
    }),
    "advisor: OFF (no model)",
  );
});

test("formatEconomySummary describes turn batching and reaction timeouts concisely", () => {
  assert.equal(formatEconomySummary({}), "3 turns, 4m timeout");
  assert.equal(formatEconomySummary({ maxBehind: 1, flushTimeoutMs: 120_000 }), "1 turn, 2m timeout");
  assert.equal(formatEconomySummary({ maxBehind: 5, flushTimeoutMs: 30_000 }), "5 turns, 30s timeout");
});

test("project overrides target the effective inherited advisor without creating duplicate rosters", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-scope-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  try {
    // 1. User config defines named advisor "reviewer" with custom tools, instructions, and maxBehind: 1
    const userDoc: WatchdogConfigDoc = {
      maxBehind: 1,
      advisors: [
        {
          name: "reviewer",
          model: "openai/user-model",
          tools: ["read", "grep"],
          instructions: "check syntax strictly",
        },
      ],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    // Initial discovery with no project config
    const initial = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(initial.advisors.length, 1);
    assert.equal(initial.advisors[0]?.name, "reviewer");
    assert.equal(initial.advisors[0]?.model, "openai/user-model");
    assert.equal(initial.advisors[0]?.maxBehind, 1);

    // 2. Simulate project override: change model and cadence for the effective advisor ("reviewer")
    const projectFilePath = path.join(cwd, "WATCHDOG.yml");
    const projectDoc: WatchdogConfigDoc = {
      maxBehind: 5,
      advisors: [
        {
          name: initial.advisors[0]!.name,
          model: "anthropic/claude-3-5-sonnet",
          tools: initial.advisors[0]!.tools,
          instructions: initial.advisors[0]!.instructions,
          maxBehind: 5,
        },
      ],
    };
    await saveWatchdogConfigFile(projectFilePath, projectDoc);

    // 3. Re-discover: must STILL have exactly 1 advisor named "reviewer" (NOT adding a "default" advisor)
    const discovered = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(discovered.advisors.length, 1, "must not add duplicate default advisor");
    assert.equal(discovered.advisors[0]?.name, "reviewer");
    assert.equal(discovered.advisors[0]?.model, "anthropic/claude-3-5-sonnet");
    assert.deepEqual(discovered.advisors[0]?.tools, ["read", "grep"]);
    assert.equal(discovered.advisors[0]?.instructions, "check syntax strictly");
    assert.equal(discovered.advisors[0]?.maxBehind, 5, "project economy override must govern runtime");

    // 4. Status line reflects the overridden single advisor
    const statusText = formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [{ name: discovered.advisors[0]!.name, model: discovered.advisors[0]!.model, status: "running" }],
    });
    assert.equal(statusText, "advisor: reviewer · claude-3-5-sonnet ON");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("applyAdvisorModelSelection repeatedly clearing model remains idempotent and shadows inherited pin", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-shadow-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  try {
    // 1. User config has pinned model
    const userDoc: WatchdogConfigDoc = {
      advisors: [{ name: "default", model: "openai/pinned-model" }],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    const initial = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(initial.advisors[0]?.model, "openai/pinned-model");

    // 2. First clear through applyAdvisorModelSelection (simulates selecting "follow session")
    await applyAdvisorModelSelection({
      cwd,
      agentDir,
      pickedModel: undefined,
      targetScope: "project",
      effectiveAdvisor: initial.advisors[0],
    });

    const first = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(first.advisors.length, 1);
    assert.equal(first.advisors[0]?.name, "default");
    assert.equal(first.advisors[0]?.model, undefined, "first clear must shadow user model");

    // 3. Second clear through applyAdvisorModelSelection (simulates selecting "follow session" again)
    await applyAdvisorModelSelection({
      cwd,
      agentDir,
      pickedModel: undefined,
      targetScope: "project",
      effectiveAdvisor: first.advisors[0],
    });

    const second = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(second.advisors.length, 1);
    assert.equal(second.advisors[0]?.name, "default");
    assert.equal(second.advisors[0]?.model, undefined, "repeated clear must remain idempotent and not resurrect user pin");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("applyAdvisorModelSelection preserves enabled: false on inherited advisor", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-disabled-override-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  try {
    const userDoc: WatchdogConfigDoc = {
      advisors: [{ name: "reviewer", model: "openai/pinned-model", enabled: false, tools: ["read"] }],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    const initial = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(initial.advisors[0]?.enabled, false);

    // Apply project model override
    await applyAdvisorModelSelection({
      cwd,
      agentDir,
      pickedModel: "anthropic/claude-3-5-sonnet",
      targetScope: "project",
      effectiveAdvisor: initial.advisors[0],
    });

    const discovered = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(discovered.advisors.length, 1);
    assert.equal(discovered.advisors[0]?.name, "reviewer");
    assert.equal(discovered.advisors[0]?.model, "anthropic/claude-3-5-sonnet");
    assert.equal(discovered.advisors[0]?.enabled, false, "must preserve disabled state across model change");
    assert.deepEqual(discovered.advisors[0]?.tools, ["read"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("applyAdvisorModelSelection returns cancelled: true when user escapes scope picker", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-cancel-scope-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  try {
    // User config exists, but project config does NOT exist
    const userDoc: WatchdogConfigDoc = {
      advisors: [{ name: "reviewer", model: "openai/pinned-model" }],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    const result = await applyAdvisorModelSelection({
      cwd,
      agentDir,
      pickedModel: "anthropic/claude-3-5-sonnet",
      effectiveAdvisor: { name: "reviewer" },
      askScope: async () => undefined, // simulates Escape
    });

    assert.equal(result.cancelled, true);
    // Project config must NOT have been created
    const projectFilePath = path.join(cwd, "WATCHDOG.yml");
    const exists = await fs.access(projectFilePath).then(() => true).catch(() => false);
    assert.equal(exists, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("inherited pinned advisor retains pinned model and label both ON and OFF", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-inherited-pin-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  try {
    const userDoc: WatchdogConfigDoc = {
      advisors: [{ name: "reviewer", model: "openai/gpt-4o" }],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    const discovered = await discoverAdvisorConfigs(cwd, agentDir);
    assert.equal(discovered.advisors.length, 1);
    const effective = discovered.advisors[0]!;
    assert.equal(effective.name, "reviewer");
    assert.equal(effective.model, "openai/gpt-4o");

    // When session is OFF (overview is empty)
    const isPinnedOff = effective.model !== undefined;
    const cleanPrimaryOff = cleanModelId(effective.model);
    assert.equal(isPinnedOff, true);
    assert.equal(cleanPrimaryOff, "gpt-4o");
    assert.equal(`Model: ${cleanPrimaryOff} (pinned)`, "Model: gpt-4o (pinned)");

    // When session is ON
    const statusText = formatAdvisorStatusBar({
      runtimeEnabled: true,
      paused: false,
      advisors: [{ name: effective.name, model: effective.model, status: "running" }],
    });
    assert.equal(statusText, "advisor: reviewer · gpt-4o ON");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project settings show inherited model and timing even when the session is OFF", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-menu-ui-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    // User config defines a pinned model and custom cadence of 1 turn
    const userDoc: WatchdogConfigDoc = {
      maxBehind: 1,
      advisors: [{ name: "reviewer", model: "openai/pinned-model", maxBehind: 1 }],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "advisor") commandHandler = def.handler;
      },
      registerMessageRenderer() {},
      registerShortcut() {},
      on() {},
      appendEntry() {},
      sendMessage() {},
    };
    initAdvisorExtension(pi as any);
    assert.ok(commandHandler, "advisor command must be registered");

    let mainTitle = "";
    let mainOptions: string[] = [];
    let settingsTitle = "";
    let settingsOptions: string[] = [];
    const ctx = {
      cwd,
      mode: "tui",
      ui: {
        select: async (title: string, options: string[]) => {
          if (title.startsWith("pi-omp-advisor ·")) {
            mainTitle = title;
            mainOptions = options;
            return settingsOptions.length ? "Close" : "Settings for this project…";
          }
          settingsTitle = title;
          settingsOptions = options;
          return "Back to advisor controls";
        },
        notify: () => {},
        setStatus: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    };

    // Execute the registered command with session OFF
    await commandHandler!("", ctx as any);

    assert.ok(mainTitle.includes("OFF"), `title should indicate OFF, got: ${mainTitle}`);
    assert.ok(mainOptions.includes("User defaults for all projects…"));
    assert.ok(settingsTitle.includes(path.join(cwd, "WATCHDOG.yml")));
    assert.equal(settingsOptions.find(opt => opt.startsWith("Advisor model:")), "Advisor model: pinned-model (inherited)…");
    assert.equal(settingsOptions.find(opt => opt.startsWith("Timing & cost")), "Timing & cost (1 turn, 4m timeout)…");
  } finally {
    if (prevAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("registered advisor command renders inherited cadence for implicit default advisor when session is OFF", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-implicit-cadence-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    // User config defines only top-level cadence, with no explicit advisors (implicit default)
    const userDoc: WatchdogConfigDoc = {
      main: false,
      maxBehind: 1,
      flushTimeoutMs: 120_000,
      flushOnSettled: false,
      advisors: [],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "advisor") commandHandler = def.handler;
      },
      registerMessageRenderer() {},
      registerShortcut() {},
      on() {},
      appendEntry() {},
      sendMessage() {},
    };
    initAdvisorExtension(pi as any);
    assert.ok(commandHandler);

    let capturedSettingsOptions: string[] = [];
    let capturedEconomyOptions: string[] = [];
    let selectCallCount = 0;
    const ctx = {
      cwd,
      mode: "tui",
      ui: {
        select: async (_title: string, options: string[]) => {
          selectCallCount++;
          if (selectCallCount === 1) return "Settings for this project…";
          if (selectCallCount === 2) {
            capturedSettingsOptions = options;
            return options.find(opt => opt.startsWith("Timing & cost"));
          }
          if (selectCallCount === 3) {
            capturedEconomyOptions = options;
            return "Back (discard unapplied changes)";
          }
          if (selectCallCount === 4) return "Back to advisor controls";
          return "Close";
        },
        notify: () => {},
        setStatus: () => {},
      },
      modelRegistry: { getAvailable: () => [] },
    };

    await commandHandler!("", ctx as any);

    const timingRow = capturedSettingsOptions.find(opt => opt.startsWith("Timing & cost"));
    assert.equal(timingRow, "Timing & cost (1 turn, 2m timeout)…");

    const turnOption = capturedEconomyOptions.find(opt => opt.startsWith("Turn batching:"));
    assert.equal(turnOption, "Turn batching: 1 primary turn per wake");

    const timeoutOption = capturedEconomyOptions.find(opt => opt.startsWith("Long-job reaction timeout:"));
    assert.equal(timeoutOption, "Long-job reaction timeout: 2m (120000ms)");

    const settledOption = capturedEconomyOptions.find(opt => opt.startsWith("Deliver on agent settled:"));
    assert.equal(settledOption, "Deliver on agent settled: Disabled (wait for full batch)");
  } finally {
    if (prevAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("applyAdvisorModelSelection distinguishes user vs project scope with different rosters", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-mixed-rosters-test-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });

  try {
    // 1. User config has advisor "reviewer"
    const userDoc: WatchdogConfigDoc = {
      advisors: [{ name: "reviewer", model: "openai/m1", tools: ["read"] }],
    };
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), userDoc);

    // 2. Project config has advisor "security"
    const projectDoc: WatchdogConfigDoc = {
      advisors: [{ name: "security", model: "openai/m2", tools: ["grep"] }],
    };
    await saveWatchdogConfigFile(path.join(cwd, "WATCHDOG.yml"), projectDoc);

    // 3. Edit user scope explicitly: must update "reviewer", without touching "security" or copying project tools
    await applyAdvisorModelSelection({
      cwd,
      agentDir,
      targetScope: "user",
      pickedModel: "openai/m3",
    });

    const updatedUser = await loadWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"));
    assert.equal(updatedUser.advisors.length, 1);
    assert.equal(updatedUser.advisors[0]?.name, "reviewer");
    assert.equal(updatedUser.advisors[0]?.model, "openai/m3");
    assert.deepEqual(updatedUser.advisors[0]?.tools, ["read"], "user config must not inherit project tools");

    // 4. Edit project scope explicitly: must update "security", without touching user "reviewer"
    await applyAdvisorModelSelection({
      cwd,
      agentDir,
      targetScope: "project",
      targetAdvisorName: "security",
      pickedModel: "openai/m4",
    });

    const updatedProject = await loadWatchdogConfigFile(path.join(cwd, "WATCHDOG.yml"));
    assert.equal(updatedProject.advisors.length, 1);
    assert.equal(updatedProject.advisors[0]?.name, "security");
    assert.equal(updatedProject.advisors[0]?.model, "openai/m4");
    assert.deepEqual(updatedProject.advisors[0]?.tools, ["grep"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function registerAdvisorCommandForMenuTest(): (args: string, ctx: unknown) => Promise<void> {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  initAdvisorExtension({
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "advisor") handler = def.handler;
    },
    registerMessageRenderer() {},
    registerShortcut() {},
    on() {},
    appendEntry() {},
    sendMessage() {},
  } as any);
  assert.ok(handler);
  return handler;
}

test("main menu edits user defaults without touching project attention", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-defaults-menu-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), { main: true, subagents: false, advisors: [] });
    const projectAttention = path.join(cwd, "WATCHDOG.md");
    await fs.writeFile(projectAttention, "Leave this project attention alone.");
    const handler = registerAdvisorCommandForMenuTest();
    let controlsVisits = 0;
    let configVisits = 0;
    let defaultsVisits = 0;
    let instructionVisits = 0;
    const ctx = {
      cwd, mode: "tui", modelRegistry: { getAvailable: () => [] },
      ui: {
        select: async (title: string, options: string[]) => {
          if (title.startsWith("pi-omp-advisor ·")) {
            controlsVisits++;
            assert.ok(options.includes("Settings for this project…"));
            assert.ok(options.includes("User defaults for all projects…"));
            return controlsVisits === 1 ? "User defaults for all projects…" : "Close";
          }
          if (title.startsWith("User defaults (unless project overrides)")) {
            assert.ok(title.includes(path.join(agentDir, "WATCHDOG.yml")));
            configVisits++;
            if (configVisits === 1) assert.equal(options[0], "Advisor ON/OFF user defaults (main ON, subagents OFF)…");
            if (configVisits === 2) assert.equal(options[0], "Advisor ON/OFF user defaults (main OFF, subagents ON)…");
            return configVisits === 1 ? options[0]
              : configVisits === 2 ? "Shared instructions & attention (WATCHDOG.yml / WATCHDOG.md)…"
              : "Back to advisor controls";
          }
          if (title.startsWith("Advisor ON/OFF defaults ·")) {
            defaultsVisits++;
            return defaultsVisits === 1 ? options.find(option => option.startsWith("Watch main sessions by default:"))
              : defaultsVisits === 2 ? options.find(option => option.startsWith("Watch sub-agent sessions by default:"))
              : "Save & Apply changes";
          }
          if (title.startsWith("User-default instructions & attention ·")) {
            assert.ok(title.includes(path.join(agentDir, "WATCHDOG.yml")));
            instructionVisits++;
            const attention = options.find(option => option.startsWith("User-default attention in WATCHDOG.md:"));
            assert.ok(attention);
            return instructionVisits === 1 ? attention : "Back";
          }
          throw new Error(`Unexpected menu: ${title}`);
        },
        editor: async () => "Watch for repeated errors across projects.",
        notify: () => {}, setStatus: () => {},
      },
    };
    await handler("", ctx as any);
    assert.equal(controlsVisits, 2);
    assert.equal(instructionVisits, 2);
    const global = await loadWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"));
    assert.equal(global.main, false);
    assert.equal(global.subagents, true);
    assert.equal(await fs.readFile(path.join(agentDir, "WATCHDOG.md"), "utf8"), "Watch for repeated errors across projects.");
    assert.equal(await fs.readFile(projectAttention, "utf8"), "Leave this project attention alone.");
    await assert.rejects(fs.access(path.join(cwd, "WATCHDOG.yml")));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("project defaults reset to inherited values and toggle from those values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-inherited-defaults-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), { main: false, subagents: true, advisors: [] });
    await saveWatchdogConfigFile(path.join(cwd, "WATCHDOG.yml"), { main: true, subagents: false, advisors: [] });
    const handler = registerAdvisorCommandForMenuTest();
    let controlsVisits = 0;
    let configVisits = 0;
    let defaultsVisits = 0;
    const ctx = {
      cwd, mode: "tui", modelRegistry: { getAvailable: () => [] },
      ui: {
        select: async (title: string, options: string[]) => {
          if (title.startsWith("pi-omp-advisor ·")) {
            controlsVisits++;
            return controlsVisits === 1 ? "Settings for this project…" : "Close";
          }
          if (title.startsWith("Project settings ·")) {
            configVisits++;
            if (configVisits === 1) assert.equal(options[0], "Advisor ON/OFF for this project (main ON, subagents OFF)…");
            return configVisits === 1 ? options[0] : "Back to advisor controls";
          }
          if (title.startsWith("Advisor ON/OFF defaults ·")) {
            defaultsVisits++;
            const main = options.find(option => option.startsWith("Watch main sessions by default:"));
            const subagents = options.find(option => option.startsWith("Watch sub-agent sessions by default:"));
            assert.ok(main && subagents);
            if (defaultsVisits === 1) {
              assert.ok(main.includes("on (set here)"));
              assert.ok(subagents.includes("off (set here)"));
              return "Reset main-session default to inherit";
            }
            if (defaultsVisits === 2) {
              assert.ok(main.includes("off (inherited)"));
              return main;
            }
            if (defaultsVisits === 3) {
              assert.ok(main.includes("on (set here)"));
              return "Reset sub-agent default to inherit";
            }
            if (defaultsVisits === 4) {
              assert.ok(subagents.includes("on (inherited)"));
              return subagents;
            }
            assert.ok(subagents.includes("off (set here)"));
            return "Save & Apply changes";
          }
          throw new Error(`Unexpected menu: ${title}`);
        },
        notify: () => {}, setStatus: () => {},
      },
    };
    await handler("", ctx as any);
    assert.equal(defaultsVisits, 5);
    const project = await loadWatchdogConfigFile(path.join(cwd, "WATCHDOG.yml"));
    assert.equal(project.main, true);
    assert.equal(project.subagents, false);
    const global = await loadWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"));
    assert.equal(global.main, false);
    assert.equal(global.subagents, true);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saving a main-session default while OFF recomputes the current session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-advisor-enable-default-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(cwd);
  await fs.mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    // An unresolved model makes a real attempted startup observable without creating a child agent.
    await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), {
      main: false, advisors: [{ name: "reviewer", model: "openai/unavailable" }],
    });
    const handler = registerAdvisorCommandForMenuTest();
    let controlsVisits = 0;
    let defaultsVisits = 0;
    const statuses: string[] = [];
    const ctx = {
      cwd, mode: "tui", hasUI: true,
      modelRegistry: { getAvailable: () => [], runtime: { streamSimple() {}, getModel: () => undefined } },
      ui: {
        select: async (title: string, options: string[]) => {
          if (title.startsWith("pi-omp-advisor ·")) {
            controlsVisits++;
            return controlsVisits === 1 ? "User defaults for all projects…" : "Close";
          }
          if (title.startsWith("User defaults (unless project overrides)")) {
            return defaultsVisits ? "Back to advisor controls" : options[0];
          }
          if (title.startsWith("Advisor ON/OFF defaults ·")) {
            defaultsVisits++;
            return defaultsVisits === 1 ? options.find(option => option.startsWith("Watch main sessions by default:")) : "Save & Apply changes";
          }
          throw new Error(`Unexpected menu: ${title}`);
        },
        notify: () => {}, setStatus: (_key: string, status: string) => statuses.push(status),
      },
    };
    await handler("", ctx as any);
    const filePath = path.join(agentDir, "WATCHDOG.yml");
    assert.equal((await loadWatchdogConfigFile(filePath)).main, true);
    assert.ok(statuses.includes("advisor: OFF (no model)"), `expected an attempted activation, got ${statuses.join(", ")}`);

    // Temporary OFF lasts until the user deliberately changes and saves the persistent default.
    await handler("off", ctx as any);
    assert.equal(statuses.at(-1), "advisor: OFF");
    const activations = statuses.filter(status => status === "advisor: OFF (no model)").length;
    await saveWatchdogConfigFile(filePath, { main: false, advisors: [{ name: "reviewer", model: "openai/unavailable" }] });
    controlsVisits = 0;
    defaultsVisits = 0;
    await handler("", ctx as any);
    assert.equal((await loadWatchdogConfigFile(filePath)).main, true);
    assert.ok(statuses.filter(status => status === "advisor: OFF (no model)").length > activations);
    assert.equal(statuses.at(-1), "advisor: OFF (no model)");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
