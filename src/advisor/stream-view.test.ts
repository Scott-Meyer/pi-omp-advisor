import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showAdvisorStream, type AdvisorStreamSnapshot } from "./stream-view.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

interface Mounted {
  handleInput(data: string): void;
  render(width: number): string[];
  dispose?(): void;
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

test("the stream popup renders the advisor context live, follows the end, and closes cleanly", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const snapshots: AgentMessage[] = [userMessage("marker-1 observed"), assistantMessage("marker-1 reviewed")];
  const snapshot = (): AdvisorStreamSnapshot => ({ name: "reviewer", model: "openai-codex/gpt-5.6-sol-long-route", streaming: false, messages: [...snapshots] });

  let mounted: Mounted | undefined;
  const closed = showAdvisorStream(
    ((factory: any, opts: any) =>
      new Promise<string | null>(resolve => {
        mounted = factory({ requestRender: () => {} }, plainTheme, {}, (value: string | null) => resolve(value)) as Mounted;
        assert.equal(opts.overlay, true, "the stream is an overlay popup, not an editor takeover");
        assert.equal(opts.overlayOptions.visible(100, 40), true, "the overlay stays visible");
      })) as any,
    snapshot,
  );

  // The initial sync ran inside the factory: content is already rendered.
  const initial = mounted!.render(80);
  assert.ok(initial.join("\n").includes("marker-1 observed"), "the advisor's own context is visible");
  assert.ok(initial.join("\n").includes("Advisor stream · reviewer · openai-codex/gpt-5.6-sol-long-route · IDLE"), "the header names the advisor, model, and state");
  const narrow = mounted!.render(50);
  assert.ok(narrow.join("\n").includes("openai-codex/gpt-5.6-sol-long-route"), "a long route wraps instead of being clipped");
  assert.ok(narrow.every(line => visibleWidth(line) <= 50), "every wrapped stream line stays within the overlay width");

  // A new observation arrives; the next poll picks it up.
  snapshots.push(userMessage("marker-2 observed"), assistantMessage("marker-2 reviewed"));
  t.mock.timers.tick(800);
  assert.ok(mounted!.render(80).join("\n").includes("marker-2 reviewed"), "polling follows new content");

  // Closing via Kitty-protocol Escape (\u001b[27u) resolves the popup — the
  // panel matches keys terminal-aware, not as raw legacy escape strings.
  mounted!.handleInput("\u001b[27u");
  assert.equal(await closed, null);

  // dispose cleared the poll timer: no further updates reach a closed panel.
  snapshots.push(userMessage("marker-3 observed"));
  t.mock.timers.tick(3000);
  assert.ok(!mounted!.render(80).join("\n").includes("marker-3"), "a closed stream stops following");
});

test("scrolling up pins the view and landing back at the end resumes following", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const messages: AgentMessage[] = [userMessage("marker-turn-first")];
  for (let i = 2; i <= 40; i++) messages.push(userMessage(`marker-turn-${i}`));
  const snapshot = (): AdvisorStreamSnapshot => ({ name: "reviewer", model: "openai-codex/gpt-5.6-sol-long-route", streaming: true, messages: [...messages] });

  let mounted: Mounted | undefined;
  let overlayOptions: any;
  const closed = showAdvisorStream(
    ((factory: any, opts: any) =>
      new Promise<string | null>(resolve => {
        overlayOptions = opts.overlayOptions;
        mounted = factory({ requestRender: () => {} }, plainTheme, {}, (value: string | null) => resolve(value)) as Mounted;
      })) as any,
    snapshot,
  );

  const visible = (text: string): boolean => mounted!.render(80).join("\n").includes(text);
  // Default view is pinned to the end: the newest turn is on screen, the first is not.
  assert.ok(visible("marker-turn-40"), "follows the end by default");
  assert.ok(!visible("marker-turn-first"));
  overlayOptions.visible(40, 16);
  const capped = mounted!.render(40);
  assert.ok(capped.length <= Math.floor(16 * 0.8), "wrapped header plus body stays within the host overlay height cap");
  assert.ok(capped.join("\n").includes("marker-turn-40"), "header wrapping does not clip the newest followed transcript line");

  // Home key reaches the oldest content at top, and new content does not yank the view.
  mounted!.handleInput("\u001b[H");
  assert.ok(visible("marker-turn-first"), "Home reaches the oldest content");
  messages.push(userMessage("marker-turn-41"));
  t.mock.timers.tick(800);
  assert.ok(!visible("marker-turn-41"), "a scrolled-up view is not yanked to the end by new content");

  // End key returns to the end and resumes following.
  mounted!.handleInput("\u001b[F");
  assert.ok(visible("marker-turn-41"), "End returns to the newest content");
  messages.push(userMessage("marker-turn-42"));
  t.mock.timers.tick(800);
  assert.ok(visible("marker-turn-42"), "following resumes once back at the end");

  mounted!.handleInput("q");
  assert.equal(await closed, null, "Escape closes the popup");
});

test("End on a short transcript resumes following once content outgrows the viewport", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const messages: AgentMessage[] = [userMessage("short-1")];
  const snapshot = (): AdvisorStreamSnapshot => ({ name: "reviewer", streaming: false, messages: [...messages] });

  let mounted: Mounted | undefined;
  const closed = showAdvisorStream(
    ((factory: any, _opts: any) =>
      new Promise<string | null>(resolve => {
        mounted = factory({ requestRender: () => {} }, plainTheme, {}, (value: string | null) => resolve(value)) as Mounted;
      })) as any,
    snapshot,
  );

  // The transcript fits: Home disables following, End must restore it even
  // though there was never anything to scroll.
  mounted!.handleInput("\u001b[H");
  mounted!.handleInput("\u001b[F");
  for (let i = 2; i <= 40; i++) messages.push(userMessage(`grown-${i}`));
  t.mock.timers.tick(800);
  const visible = (text: string): boolean => mounted!.render(80).join("\n").includes(text);
  assert.ok(visible("grown-40"), "the newest content is on screen after End + growth");
  assert.ok(!visible("short-1"), "a full viewport shows the end, not the start");

  mounted!.handleInput("q");
  await closed;
});
