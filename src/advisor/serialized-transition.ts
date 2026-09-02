/**
 * FIFO for state transitions whose async side effects must finish before the
 * next requested state can become visible. A failed operation rejects its own
 * caller but does not poison later transitions.
 */
export class SerializedTransition {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const transition = this.#tail.then(operation);
    this.#tail = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  }
}

/**
 * Tracks a boolean state separately from the latest requested value. Toggle
 * handlers update `requested` synchronously, while serialized async work calls
 * `apply` only when that transition has actually taken effect.
 */
export class RequestedBooleanState {
  #applied: boolean;
  #requested: boolean;

  constructor(initial: boolean) {
    this.#applied = initial;
    this.#requested = initial;
  }

  get applied(): boolean {
    return this.#applied;
  }

  get requested(): boolean {
    return this.#requested;
  }

  request(value: boolean): boolean {
    this.#requested = value;
    return value;
  }

  toggleRequest(): boolean {
    return this.request(!this.#requested);
  }

  apply(value: boolean): void {
    this.#applied = value;
  }

  restore(value: boolean): void {
    this.#applied = value;
    this.#requested = value;
  }

  reject(value: boolean): void {
    if (this.#requested === value) this.#requested = this.#applied;
  }
}
