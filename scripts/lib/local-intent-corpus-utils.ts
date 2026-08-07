import { createHash } from "node:crypto";

export function sha256(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function stableJsonPretty(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

export function incrementCount(
  counts: Record<string, number>,
  key: string,
  amount = 1
) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)])
  );
}
