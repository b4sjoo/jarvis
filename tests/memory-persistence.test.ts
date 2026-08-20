import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  resolveMemoryInterviewFamilyGateDecision,
  resolveMemoryInterviewFamilies,
} from "../src/lib/memory/interview-family.js";
import { parseCuratedMemoryDraft } from "../src/lib/memory/parser.js";
import {
  buildPersistedMemoryEntryParameters,
  decodePersistedMemoryInterviewFamilies,
  encodePersistedMemoryInterviewFamilies,
  hydratePersistedMemoryInterviewFamilies,
  UPSERT_PERSISTED_MEMORY_ENTRY_SQL,
} from "../src/lib/memory/persistence.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("preserves explicit interview families across parser and persisted row encoding", () => {
  const parsed = parseCuratedMemoryDraft(
    {
      path: "curated.md",
      content: `\`\`\`yaml
entries:
  - id: mem_multi_family
    sourceIds: [source_a]
    type: interview_framework
    title: Shared design guidance
    content: Shared guidance.
    interviewFamilies: [ai-ml-system-design, system-design, ai-ml-system-design]
\`\`\``,
    },
    100
  );
  const parsedEntry = parsed.entries[0];
  assert.ok(parsedEntry);

  const encoded = encodePersistedMemoryInterviewFamilies(
    parsedEntry.interviewFamilies
  );
  const decoded = decodePersistedMemoryInterviewFamilies(encoded);
  const hydrated = {
    ...parsedEntry,
    interviewFamilies: decoded.families,
  };

  assert.equal(decoded.status, "explicit");
  assert.deepEqual(decoded.families, [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.deepEqual(resolveMemoryInterviewFamilies(hydrated).families, [
    "ai-ml-system-design",
    "system-design",
  ]);
  assert.equal(resolveMemoryInterviewFamilies(hydrated).source, "explicit");
});

test("keeps old rows on inference fallback", () => {
  assert.deepEqual(decodePersistedMemoryInterviewFamilies(null), {
    status: "missing",
  });
  assert.deepEqual(decodePersistedMemoryInterviewFamilies("[]"), {
    status: "missing",
  });
});

test("diagnoses malformed persisted families without accepting partial authority", () => {
  assert.deepEqual(decodePersistedMemoryInterviewFamilies("not-json"), {
    status: "malformed",
    reason: "invalid-json",
  });
  assert.deepEqual(
    decodePersistedMemoryInterviewFamilies(
      JSON.stringify(["behavioral", "not-a-family"])
    ),
    {
      status: "malformed",
      reason: "invalid-family",
    }
  );
});

test("round-trips explicit interview families through the real SQLite rebuild contract", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        "src-tauri/src/db/migrations/knowledge-memory-base.sql",
        "utf8"
      )
    );
    db.exec(
      readFileSync(
        "src-tauri/src/db/migrations/memory-entry-interview-families.sql",
        "utf8"
      )
    );

    const columns = db.prepare("PRAGMA table_info(memory_entries)").all();
    assert.ok(
      columns.some(
        (column) =>
          (column as { name?: string }).name === "interview_families"
      )
    );

    const parsed = parseCuratedMemoryDraft(
      {
        path: "sqlite-curated.md",
        content: `\`\`\`yaml
entries:
  - id: mem_sqlite_multi_family
    sourceIds: [source_sqlite]
    type: interview_framework
    title: Shared architecture guidance
    content: Use this guidance only for its curated interview families.
    interviewFamilies: [ai-ml-system-design, system-design]
\`\`\``,
      },
      1_700_000_000_000
    );
    const parsedEntry = parsed.entries[0];
    assert.ok(parsedEntry);

    const upsert = db.prepare(UPSERT_PERSISTED_MEMORY_ENTRY_SQL);
    upsert.run(
      ...buildPersistedMemoryEntryParameters(
        parsedEntry,
        1_700_000_000_000
      )
    );
    const row = db
      .prepare(
        "SELECT interview_families FROM memory_entries WHERE id = ?"
      )
      .get(parsedEntry.id) as { interview_families: string | null };
    const hydrated = hydratePersistedMemoryInterviewFamilies(
      parsedEntry,
      row.interview_families
    );

    assert.equal(hydrated.interviewFamiliesStatus, "explicit");
    assert.deepEqual(hydrated.entry.interviewFamilies, [
      "ai-ml-system-design",
      "system-design",
    ]);
    assert.equal(
      resolveMemoryInterviewFamilies(hydrated.entry).source,
      "explicit"
    );
    assert.equal(
      resolveMemoryInterviewFamilyGateDecision({
        entry: hydrated.entry,
        questionType: "general-system-design",
        memoryPolicy: {
          id: "general-system-design",
          allowedFamilies: ["system-design"],
        },
      }).rejectReason,
      undefined
    );
    assert.equal(
      resolveMemoryInterviewFamilyGateDecision({
        entry: hydrated.entry,
        questionType: "ai-ml-system-design",
        memoryPolicy: {
          id: "ai-ml-system-design",
          allowedFamilies: ["ai-ml-system-design"],
        },
      }).rejectReason,
      undefined
    );

    const rebuiltEntry: MemoryEntry = {
      ...parsedEntry,
      interviewFamilies: ["behavioral"],
    };
    upsert.run(
      ...buildPersistedMemoryEntryParameters(
        rebuiltEntry,
        1_700_000_001_000
      )
    );
    const rebuiltRow = db
      .prepare(
        "SELECT interview_families FROM memory_entries WHERE id = ?"
      )
      .get(parsedEntry.id) as { interview_families: string | null };
    const rebuilt = hydratePersistedMemoryInterviewFamilies(
      parsedEntry,
      rebuiltRow.interview_families
    );
    assert.deepEqual(rebuilt.entry.interviewFamilies, ["behavioral"]);

    const legacyEntry: MemoryEntry = {
      ...parsedEntry,
      id: "mem_sqlite_legacy",
      title: "Coding algorithm guide",
      tags: ["coding"],
      interviewFamilies: undefined,
    };
    upsert.run(
      ...buildPersistedMemoryEntryParameters(
        legacyEntry,
        1_700_000_002_000
      )
    );
    const legacyRow = db
      .prepare(
        "SELECT interview_families FROM memory_entries WHERE id = ?"
      )
      .get(legacyEntry.id) as { interview_families: string | null };
    const legacy = hydratePersistedMemoryInterviewFamilies(
      legacyEntry,
      legacyRow.interview_families
    );
    assert.equal(legacy.interviewFamiliesStatus, "missing");
    assert.deepEqual(resolveMemoryInterviewFamilies(legacy.entry).families, [
      "coding",
    ]);

    db.prepare(
      "UPDATE memory_entries SET interview_families = ? WHERE id = ?"
    ).run("not-json", legacyEntry.id);
    const malformedRow = db
      .prepare(
        "SELECT interview_families FROM memory_entries WHERE id = ?"
      )
      .get(legacyEntry.id) as { interview_families: string | null };
    const malformed = hydratePersistedMemoryInterviewFamilies(
      legacyEntry,
      malformedRow.interview_families
    );
    assert.equal(malformed.interviewFamiliesStatus, "malformed");
    assert.deepEqual(resolveMemoryInterviewFamilies(malformed.entry).families, [
      "coding",
    ]);
  } finally {
    db.close();
  }
});
