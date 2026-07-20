interface ScheduledCallback {
  id: number;
  dueAt: number;
  callback: () => void;
}

export class ManualScheduler {
  private currentTime = 0;
  private nextId = 1;
  private readonly callbacks = new Map<number, ScheduledCallback>();

  now() {
    return this.currentTime;
  }

  schedule(delayMs: number, callback: () => void) {
    const id = this.nextId++;
    this.callbacks.set(id, {
      id,
      dueAt: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return id;
  }

  cancel(id: number) {
    return this.callbacks.delete(id);
  }

  advanceBy(durationMs: number) {
    this.currentTime += Math.max(0, durationMs);
    this.runDueCallbacks();
  }

  pendingCount() {
    return this.callbacks.size;
  }

  private runDueCallbacks() {
    while (true) {
      const next = [...this.callbacks.values()]
        .filter((candidate) => candidate.dueAt <= this.currentTime)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) return;

      this.callbacks.delete(next.id);
      next.callback();
    }
  }
}
