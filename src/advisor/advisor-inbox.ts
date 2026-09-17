import { randomUUID } from "node:crypto";
import type { AdvisorNote, AdvisorSeverity, PendingAdvisorNote } from "./advise-logic.ts";

export interface QueuedAdvisorNote extends AdvisorNote {
  id: number;
}

/**
 * Session-scoped holding area for preserved advice. Notes stay here instead of
 * entering pi's private `nextTurn` queue, so the extension can show and dismiss
 * them before they are added to the primary transcript/model context.
 */
export class AdvisorInbox {
  #items: QueuedAdvisorNote[] = [];
  #nextId = 1;

  get items(): readonly QueuedAdvisorNote[] {
    return this.#items;
  }

  enqueue(note: AdvisorNote): QueuedAdvisorNote {
    const item = { ...note, adviceId: note.adviceId ?? randomUUID(), id: this.#nextId++ };
    this.#items.push(item);
    return item;
  }

  /** Resolve menu snapshots at handoff, so a withdrawn/revised note never leaks stale text. */
  select(ids: Iterable<number>): QueuedAdvisorNote[] {
    const wanted = new Set(ids);
    return this.#items.filter(item => wanted.has(item.id)).map(item => ({ ...item }));
  }

  pendingFor(advisor: string | undefined): PendingAdvisorNote[] {
    return this.#items
      .filter((item): item is QueuedAdvisorNote & PendingAdvisorNote => item.advisor === advisor && typeof item.adviceId === "string")
      .map(({ id: _id, ...note }) => ({ ...note }));
  }

  revise(advisor: string | undefined, adviceId: string, note: string, shortTitle?: string, severity?: AdvisorSeverity, model?: string): boolean {
    if (!note.trim()) return false;
    const index = this.#items.findIndex(item => item.adviceId === adviceId && item.advisor === advisor);
    if (index < 0) return false;
    this.#items[index] = {
      ...this.#items[index]!,
      note,
      ...(shortTitle !== undefined ? { shortTitle: shortTitle || undefined } : {}),
      ...(severity !== undefined ? { severity } : {}),
      ...(model !== undefined ? { model } : {}),
      updatedAt: Date.now(),
    };
    return true;
  }

  withdraw(advisor: string | undefined, adviceId: string): boolean {
    const item = this.#items.find(item => item.adviceId === adviceId && item.advisor === advisor);
    return item ? this.dismiss(item.id) : false;
  }

  dismiss(id: number): boolean {
    const index = this.#items.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.#items.splice(index, 1);
    return true;
  }

  dismissMany(ids: Iterable<number>): number {
    const dismissed = new Set(ids);
    const before = this.#items.length;
    this.#items = this.#items.filter(item => !dismissed.has(item.id));
    return before - this.#items.length;
  }

  restore(items: readonly QueuedAdvisorNote[]): void {
    this.#items = items.map(item => ({ ...item, adviceId: item.adviceId ?? randomUUID() }));
    this.#nextId = Math.max(0, ...items.map(item => item.id)) + 1;
  }

  takeAll(): QueuedAdvisorNote[] {
    const items = this.#items;
    this.#items = [];
    return items;
  }

  clear(): void {
    this.#items = [];
  }
}
