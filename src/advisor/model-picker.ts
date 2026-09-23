/**
 * A searchable, scrolling advisor-model picker.
 *
 * Modeled on Pi's own `/model` selector: the search box has focus from the
 * start, typing fuzzy-filters by provider, id, and display name, the list shows
 * a bounded window around the selection, and Enter picks the highlighted row.
 * A plain `ui.select` list becomes unusable once a user has dozens of models.
 *
 * Hosts without an interactive custom-component surface (RPC, print, tests
 * with a minimal UI) fall back to `ui.select`, so the picker's result contract
 * is the same everywhere.
 */
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

/** A model the advisor can be pinned to. */
export interface PickableModel {
  provider: string;
  id: string;
  name?: string;
}

/**
 * The user's decision: pin a `provider/id` model, follow the primary session's
 * model (no override), or cancel (`null`).
 */
export type ModelPick = { kind: "model"; model: string } | { kind: "follow-session" } | null;

export interface ModelPickerOptions {
  title: string;
  models: readonly PickableModel[];
  /** Currently configured `provider/id`, if pinned. */
  current?: string;
}

type PickerUi = Pick<ExtensionContext["ui"], "select"> & Partial<Pick<ExtensionContext["ui"], "custom">>;

type Row =
  | { kind: "follow-session" }
  | { kind: "model"; key: string; value: string; model: PickableModel };

const FOLLOW_SESSION_LABEL = "(use the current Pi session model — no override)";
const FOLLOW_SESSION_SEARCH = "follow session model current pi no override none";
const MAX_VISIBLE = 10;
const THINKING_LEVEL_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function modelKey(model: PickableModel): string {
  return `${model.provider}/${model.id}`;
}

/** Same ranking text as Pi's `/model`: provider-prefixed forms before the bare id. */
function searchText(row: Row): string {
  if (row.kind === "follow-session") return FOLLOW_SESSION_SEARCH;
  const { provider, id, name } = row.model;
  return `${provider} ${provider}/${id} ${provider} ${id}${name ? ` ${name}` : ""}`;
}

function buildRows(models: readonly PickableModel[], current: string | undefined): Row[] {
  const available = new Set(models.map(modelKey));
  let currentKey = current && available.has(current) ? current : undefined;
  if (!currentKey && current) {
    const suffix = current.lastIndexOf(":");
    const level = suffix > current.indexOf("/") ? current.slice(suffix + 1).toLowerCase() : "";
    const stripped = suffix > 0 ? current.slice(0, suffix) : "";
    if (THINKING_LEVEL_SUFFIXES.has(level) && available.has(stripped)) currentKey = stripped;
  }
  const modelRows = models
    .map(model => {
      const key = modelKey(model);
      return { kind: "model" as const, key, value: key === currentKey && current ? current : key, model };
    })
    .sort((a, b) => {
      if (a.key === currentKey) return -1;
      if (b.key === currentKey) return 1;
      return a.model.provider.localeCompare(b.model.provider);
    });
  return [{ kind: "follow-session" }, ...modelRows];
}

function toPick(row: Row): ModelPick {
  return row.kind === "follow-session" ? { kind: "follow-session" } : { kind: "model", model: row.value };
}

/** The interactive picker component. Exported for behavioral tests. */
export class AdvisorModelPicker implements Component, Focusable {
  readonly #search = new Input();
  readonly #rows: Row[];
  #filtered: Row[];
  #selected = 0;
  #focused = false;

  constructor(
    private readonly options: ModelPickerOptions,
    private readonly theme: Pick<Theme, "fg">,
    private readonly requestRender: () => void,
    private readonly done: (pick: ModelPick) => void,
  ) {
    this.#rows = buildRows(options.models, options.current);
    this.#filtered = this.#rows;
    const currentIndex = this.#rows.findIndex(row =>
      options.current ? row.kind === "model" && row.value === options.current : row.kind === "follow-session");
    this.#selected = Math.max(0, currentIndex);
    this.#search.onSubmit = () => this.#confirm();
  }

  get focused(): boolean {
    return this.#focused;
  }

  /** Forward focus so the search input places the hardware cursor (IME). */
  set focused(value: boolean) {
    this.#focused = value;
    this.#search.focused = value;
  }

  invalidate(): void {
    this.#search.invalidate();
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const count = this.#filtered.length;
    if (kb.matches(data, "tui.select.up")) {
      if (count) this.#selected = this.#selected === 0 ? count - 1 : this.#selected - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      if (count) this.#selected = this.#selected === count - 1 ? 0 : this.#selected + 1;
    } else if (kb.matches(data, "tui.select.pageUp")) {
      this.#selected = Math.max(0, this.#selected - MAX_VISIBLE);
    } else if (kb.matches(data, "tui.select.pageDown")) {
      this.#selected = Math.max(0, Math.min(count - 1, this.#selected + MAX_VISIBLE));
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.#confirm();
      return;
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.done(null);
      return;
    } else {
      this.#search.handleInput(data);
      this.#applyFilter(this.#search.getValue());
    }
    this.requestRender();
  }

  #confirm(): void {
    const row = this.#filtered[this.#selected];
    if (row) this.done(toPick(row));
  }

  #applyFilter(query: string): void {
    this.#filtered = query.trim() ? fuzzyFilter(this.#rows, query, searchText) : this.#rows;
    // Like Pi's /model: a query highlights its best match; clearing keeps position.
    this.#selected = query.trim() ? 0 : Math.min(this.#selected, Math.max(0, this.#filtered.length - 1));
  }

  #rowLine(row: Row, selected: boolean): string {
    const t = this.theme;
    const cursor = selected ? t.fg("accent", "→ ") : "  ";
    if (row.kind === "follow-session") {
      const mark = this.options.current ? "  " : t.fg("accent", "✓ ");
      return `${cursor}${mark}${selected ? t.fg("accent", FOLLOW_SESSION_LABEL) : FOLLOW_SESSION_LABEL}`;
    }
    const mark = row.value === this.options.current ? t.fg("accent", "✓ ") : "  ";
    const id = selected ? t.fg("accent", row.model.id) : row.model.id;
    return `${cursor}${mark}${id} ${t.fg("muted", `[${row.model.provider}]`)}`;
  }

  render(width: number): string[] {
    const t = this.theme;
    const fit = (line: string) => truncateToWidth(line, width);
    const border = t.fg("border", "─".repeat(Math.max(1, width)));
    const lines = [border, fit(t.fg("accent", this.options.title)), "", ...this.#search.render(width), ""];

    const total = this.#filtered.length;
    const start = Math.max(0, Math.min(this.#selected - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
    const end = Math.min(start + MAX_VISIBLE, total);
    for (let i = start; i < end; i++) lines.push(fit(this.#rowLine(this.#filtered[i]!, i === this.#selected)));
    if (start > 0 || end < total) lines.push(t.fg("muted", `  (${this.#selected + 1}/${total})`));

    const selected = this.#filtered[this.#selected];
    if (!selected) lines.push(t.fg("muted", "  No matching models"));
    else if (selected.kind === "model" && selected.model.name) {
      lines.push("", fit(t.fg("muted", `  Model Name: ${selected.model.name}`)));
    }
    lines.push("", fit(t.fg("dim", "  type to search · ↑↓ navigate · enter select · esc cancel")), border);
    return lines;
  }
}

/** Fallback for hosts without interactive custom components. */
async function pickWithSelect(ui: PickerUi, options: ModelPickerOptions): Promise<ModelPick> {
  const rows = buildRows(options.models, options.current);
  const labels = rows.map(row =>
    row.kind === "follow-session" ? FOLLOW_SESSION_LABEL : `${row.key}${row.model.name ? ` — ${row.model.name}` : ""}`);
  const choice = await ui.select(options.title, labels);
  if (choice === undefined) return null;
  const row = rows[labels.indexOf(choice)];
  return row ? toPick(row) : null;
}

/**
 * Ask the user to choose an advisor model. Uses the searchable picker in the
 * interactive TUI and `ui.select` elsewhere.
 */
export async function pickModel(
  ui: PickerUi,
  mode: ExtensionContext["mode"] | undefined,
  options: ModelPickerOptions,
): Promise<ModelPick> {
  if (mode !== "tui" || typeof ui.custom !== "function") return pickWithSelect(ui, options);
  const picked = await ui.custom<ModelPick | undefined>((tui, theme, _keybindings, done) =>
    new AdvisorModelPicker(options, theme, () => tui.requestRender(), done));
  // A host that accepts custom() but cannot show it resolves undefined.
  return picked === undefined ? pickWithSelect(ui, options) : picked;
}
