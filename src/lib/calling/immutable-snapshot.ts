export const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
};

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface ImmutableSnapshot<T> {
  id: string;
  revision: number;
  contentHash: string;
  content: T;
  sourceReferences: string[];
  createdAt: number;
}

export async function compileImmutableSnapshot<T>(input: {
  id: string;
  revision: number;
  content: T;
  sourceReferences: string[];
  createdAt: number;
}): Promise<ImmutableSnapshot<T>> {
  const content = structuredClone(input.content);
  const contentHash = await sha256(
    canonicalize({ content, sourceReferences: [...input.sourceReferences].sort() })
  );
  return { ...input, content, sourceReferences: [...input.sourceReferences], contentHash };
}

export interface SnapshotPin {
  callSessionId: string;
  snapshotId: string;
  snapshotRevision: number;
  contentHash: string;
  pinnedAt: number;
}

export function pinSnapshot<T>(input: {
  callSessionId: string;
  snapshot: ImmutableSnapshot<T>;
  pinnedAt: number;
}): SnapshotPin {
  return {
    callSessionId: input.callSessionId,
    snapshotId: input.snapshot.id,
    snapshotRevision: input.snapshot.revision,
    contentHash: input.snapshot.contentHash,
    pinnedAt: input.pinnedAt,
  };
}
