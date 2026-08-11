import type { GuidanceFrame } from "./types.js";

export interface GuidanceReceipt {
  requestId: string;
  status:
    | "selected"
    | "dispatched"
    | "provider-returned"
    | "commit-authorized"
    | "visible"
    | "rejected"
    | "stale"
    | "failed"
    | "cancelled";
  occurredAt: number;
  reason?: string;
}

export function isCompleteGuidanceFrame(value: unknown): value is GuidanceFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<GuidanceFrame>;
  return (
    Array.isArray(frame.say) &&
    Array.isArray(frame.ask) &&
    Array.isArray(frame.avoid) &&
    Array.isArray(frame.evidence) &&
    typeof frame.callState === "string" &&
    typeof frame.nextMove === "string" &&
    [...frame.say, ...frame.ask, ...frame.avoid, ...frame.evidence].every(
      (entry) => typeof entry === "string"
    ) &&
    frame.say.some((entry) => entry.trim().length > 0)
  );
}

export class StableGuidanceStore {
  #visible: GuidanceFrame | null = null;
  #revision = 0;
  readonly #receipts: GuidanceReceipt[] = [];

  get visible() {
    return this.#visible;
  }

  get revision() {
    return this.#revision;
  }

  get receipts() {
    return [...this.#receipts];
  }

  record(receipt: GuidanceReceipt) {
    this.#receipts.push({ ...receipt });
  }

  commit(input: {
    requestId: string;
    frame: unknown;
    authorized: boolean;
    occurredAt: number;
  }) {
    if (!input.authorized) {
      this.record({
        requestId: input.requestId,
        status: "rejected",
        occurredAt: input.occurredAt,
        reason: "commit-not-authorized",
      });
      return false;
    }
    if (!isCompleteGuidanceFrame(input.frame)) {
      this.record({
        requestId: input.requestId,
        status: "failed",
        occurredAt: input.occurredAt,
        reason: "incomplete-guidance-frame",
      });
      return false;
    }
    this.#visible = structuredClone(input.frame);
    this.#revision += 1;
    this.record({
      requestId: input.requestId,
      status: "visible",
      occurredAt: input.occurredAt,
    });
    return true;
  }
}
