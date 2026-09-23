import assert from "node:assert/strict";
import test from "node:test";
import { pickModel, type ModelPick, type PickableModel } from "./model-picker.ts";

const plainTheme = { fg: (_color: string, text: string) => text };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

const manyModels: PickableModel[] = Array.from({ length: 60 }, (_, i) => ({
  provider: i % 2 ? "openai" : "anthropic",
  id: `model-${String(i).padStart(2, "0")}`,
  name: `Model ${i}`,
}));

/**
 * Drive the picker the way the TUI does: mount through ui.custom, feed raw
 * key sequences, and collect the final result plus the last rendered frame.
 */
async function drive(
  options: { models: PickableModel[]; current?: string },
  keys: string[],
): Promise<{ pick: ModelPick; frame: string[] }> {
  let frame: string[] = [];
  const ui = {
    select: async () => assert.fail("interactive TUI must not fall back to select"),
    custom: <T>(factory: (...args: any[]) => any): Promise<T> =>
      new Promise<T>(resolve => {
        let finished = false;
        const component = factory({ requestRender() {} }, plainTheme, undefined, (value: T) => {
          finished = true;
          resolve(value);
        });
        component.focused = true;
        for (const key of keys) {
          if (finished) break;
          component.handleInput(key);
          // Keep the last frame the person saw before the picker closed.
          if (!finished) frame = component.render(80);
        }
        if (!finished) frame = component.render(80);
      }),
  };
  const pick = await pickModel(ui as any, "tui", { title: "Advisor model", ...options });
  return { pick, frame };
}

test("typing searches and Enter picks the best match", async () => {
  const { pick } = await drive({ models: manyModels }, [..."openai model-37", ENTER]);
  assert.deepEqual(pick, { kind: "model", model: "openai/model-37" });
});

test("a long model list renders a bounded, scrollable window", async () => {
  const { frame } = await drive({ models: manyModels }, [UP, ESC]);
  const rows = frame.filter(line => /\[(openai|anthropic)\]/.test(line));
  assert.equal(rows.length, 10, "only a window of models is rendered");
  assert.ok(frame.some(line => line.includes("(61/61)")), "wrapping up from the top reaches the last entry");
  assert.ok(rows.some(line => line.startsWith("→")), "the selected row is visible");
});

test("opens on the configured model and can choose to follow the session model", async () => {
  const current = "openai/model-41";
  const opened = await drive({ models: manyModels, current }, [ENTER]);
  assert.deepEqual(opened.pick, { kind: "model", model: current });

  const followed = await drive({ models: manyModels, current }, [..."session", ENTER]);
  assert.deepEqual(followed.pick, { kind: "follow-session" });
});

test("preserves a configured thinking-level suffix when confirming the current model", async () => {
  const current = "openai/model-41:high";
  const { pick } = await drive({ models: manyModels, current }, [ENTER]);
  assert.deepEqual(pick, { kind: "model", model: current });
});

test("Escape cancels without choosing", async () => {
  const { pick } = await drive({ models: manyModels }, [DOWN, ESC]);
  assert.equal(pick, null);
});

test("hosts without interactive custom UI get an equivalent select list", async () => {
  let shown: string[] = [];
  const ui = {
    select: async (_title: string, options: string[]) => {
      shown = options;
      return options.find(option => option.startsWith("anthropic/model-02"));
    },
  };
  const pick = await pickModel(ui as any, "rpc", { title: "Advisor model", models: manyModels });
  assert.equal(shown.length, 61);
  assert.deepEqual(pick, { kind: "model", model: "anthropic/model-02" });
});
