export interface HumanTruthEvent<T = unknown> {
  id: string;
  callSessionId: string;
  factKey: string;
  value: T;
  source: "human";
  occurredAt: number;
  supersedesEventId?: string;
}

export class HumanTruthLedger {
  readonly #events: HumanTruthEvent[] = [];

  append<T>(event: HumanTruthEvent<T>) {
    if (this.#events.some((candidate) => candidate.id === event.id)) {
      throw new Error(`Human truth event already exists: ${event.id}`);
    }
    if (event.supersedesEventId) {
      const prior = this.#events.find(
        (candidate) => candidate.id === event.supersedesEventId
      );
      if (!prior || prior.callSessionId !== event.callSessionId || prior.factKey !== event.factKey) {
        throw new Error("A correction can supersede only the same session fact.");
      }
    }
    this.#events.push(structuredClone(event));
  }

  events() {
    return structuredClone(this.#events);
  }

  currentFacts(callSessionId: string) {
    const current = new Map<string, HumanTruthEvent>();
    for (const event of this.#events) {
      if (event.callSessionId !== callSessionId) continue;
      current.set(event.factKey, event);
    }
    return current;
  }
}
