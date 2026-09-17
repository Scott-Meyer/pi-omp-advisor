/**
 * A read-only popup over the advisor's own chat stream.
 *
 * Advisors are in-memory AgentSessions with no session file to tail, so unlike
 * pi's subagent runs (which persist transcripts to disk and offer a
 * transcript view over them), this viewer reads the live agent state
 * directly. It uses the sanctioned extension popup path — `ctx.ui.custom`
 * with `{ overlay: true }` — rather than a pane takeover.
 *
 * This is a deliberate power tool: watching the advisor's raw context is
 * occasionally the fastest way to understand why it said what it said, but it
 * is not part of the normal loop, so it lives behind an explicit
 * `/advisor stream` command rather than any always-on surface.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatSessionHistoryMarkdown } from "./session-history-format.ts";

/** One advisor's current context, captured at a moment in time. */
export interface AdvisorStreamSnapshot {
  name: string;
  streaming: boolean;
  messages: AgentMessage[];
}

const SCROLL_STEP = 1;
const PAGE_STEP = 10;

/**
 * A scrollable, follow-the-end text panel. The advisor's messages are
 * rendered through the same markdown formatter used for its own observation
 * context, so what you see is literally what it sees.
 */
class AdvisorStreamPanel implements Component {
  #header = "";
  #bodyLines: string[] = [];
  #scrollTop = 0;
  #follow = true;
  #termHeight = 24;
  /** Wrapped-line count from the last render; scroll math operates on wrapped lines. */
  #lineCount = 0;

  constructor(
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly close: () => void,
  ) {}

  /** Overlay visibility callback doubles as a terminal-size signal. */
  setTerminalSize(_width: number, height: number): void {
    if (height === this.#termHeight) return;
    this.#termHeight = height;
    this.requestRender();
  }

  invalidate(): void {
    // Everything is recomputed from live snapshots on each render.
  }

  get #visibleRows(): number {
    return Math.max(6, Math.floor(this.#termHeight * 0.6));
  }

  update(snapshot: AdvisorStreamSnapshot): void {
    const status = snapshot.streaming ? "THINKING" : "IDLE";
    this.#header = `─ Advisor stream · ${snapshot.name} · ${status} · ↑↓ PgUp/PgDn Home/End · q/Esc closes `;
    this.#bodyLines = formatSessionHistoryMarkdown(snapshot.messages).split("\n");
    this.requestRender();
  }

  #clampScroll(): void {
    const max = Math.max(0, this.#lineCount - this.#visibleRows);
    this.#scrollTop = Math.min(Math.max(0, this.#scrollTop), max);
  }

  handleInput(data: string): void {
    // Close keys first: never swallowed by scrolling. Terminal-aware
    // matching (pi-tui matchesKey) so Kitty-protocol encodings (e.g. Esc as
    // `\u001b[27u`) and alternate Home/End sequences work on every terminal
    // pi supports, not just the legacy ones.
    if (data === "q" || matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (matchesKey(data, "up")) {
      this.#follow = false;
      this.#scrollTop -= SCROLL_STEP;
    } else if (matchesKey(data, "down")) {
      this.#scrollTop += SCROLL_STEP;
    } else if (matchesKey(data, "pageUp")) {
      this.#follow = false;
      this.#scrollTop -= PAGE_STEP;
    } else if (matchesKey(data, "pageDown")) {
      this.#scrollTop += PAGE_STEP;
    } else if (matchesKey(data, "home")) {
      this.#follow = false;
      this.#scrollTop = 0;
    } else if (matchesKey(data, "end")) {
      this.#scrollTop = this.#lineCount;
      // End is an explicit "show me the newest and keep following it" — set
      // follow directly rather than via the at-end comparison, which fails
      // for a transcript that currently fits the viewport (zero scroll).
      this.#follow = true;
    } else {
      return; // Not a key we own; ignore rather than guess.
    }
    this.#clampScroll();
    // Landing on (or past) the end by scrolling resumes following new content.
    if (this.#scrollTop >= this.#lineCount - this.#visibleRows) this.#follow = true;
    this.requestRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(10, width - 2);
    // Wrap the ENTIRE transcript before slicing the viewport: slicing raw
    // lines first would clip the wrapped tails of long paragraphs that start
    // inside the viewport, and the overlay's maxHeight would hide them.
    const wrapped = this.#bodyLines.flatMap(line => wrapTextWithAnsi(line, contentWidth));
    this.#lineCount = wrapped.length;
    if (this.#follow) {
      this.#scrollTop = Math.max(0, wrapped.length - this.#visibleRows);
    }
    this.#clampScroll();
    const visible = wrapped.slice(this.#scrollTop, this.#scrollTop + this.#visibleRows);
    // Always return the current frame. A `[]` return for an unchanged frame
    // hides the popup — the overlay only renders what this returns.
    return [this.theme.fg("accent", this.#header), ...visible];
  }
}

/**
 * Open the advisor stream popup. Polls `snapshot` while open so the view
 * follows the advisor's context live; closes on q/Esc.
 */
export async function showAdvisorStream(
  custom: ExtensionContext["ui"]["custom"],
  snapshot: () => AdvisorStreamSnapshot | undefined,
): Promise<string | null> {
  // Declared before the factory runs so the overlay's visibility callback
  // (invoked per render cycle, after the factory returns) can reach the panel.
  let panelRef: AdvisorStreamPanel | undefined;
  return await custom<string | null>((tui, theme, _keybindings, done) => {
    let timer: NodeJS.Timeout | undefined;
    const closePopup = (): void => {
      if (timer) clearInterval(timer);
      done(null);
    };
    const panel = new AdvisorStreamPanel(theme, () => tui.requestRender(), closePopup);
    panelRef = panel;
    const sync = (): void => {
      const current = snapshot();
      if (current) panel.update(current);
    };
    timer = setInterval(sync, 750);
    sync();
    const mounted = panel as Component & { dispose?(): void };
    mounted.dispose = () => {
      if (timer) clearInterval(timer);
    };
    return mounted;
  }, {
    overlay: true,
    overlayOptions: {
      width: "80%",
      maxHeight: "80%",
      visible: (termWidth: number, termHeight: number) => {
        panelRef?.setTerminalSize(termWidth, termHeight);
        return true;
      },
    },
  });
}
