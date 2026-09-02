import type { AdvisorNote } from "./advise-logic.ts";

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
    const item = { ...note, id: this.#nextId++ };
    this.#items.push(item);
    return item;
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
    this.#items = items.map(item => ({ ...item }));
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
