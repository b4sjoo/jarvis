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
  buildMemoryEntryCandidate,
  decodePersistedMemoryInterviewFamilies,
  encodePersistedMemoryInterviewFamilies,
  hydratePersistedMemoryInterviewFamilies,
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

test("round-trips immutable revision interview families through SQLite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const registry = readFileSync("src-tauri/src/db/main.rs", "utf8");
    for (const match of registry.matchAll(/include_str!\("migrations\/([^"]+)"\)/g)) {
      db.exec(readFileSync(`src-tauri/src/db/migrations/${match[1]}`, "utf8"));
    }
    const parsed = parseCuratedMemoryDraft({ path: "sqlite-curated.md", content: `\`\`\`yaml
entries:
  - id: mem_sqlite_multi_family
    sourceIds: [source_sqlite]
    type: interview_framework
    title: Shared architecture guidance
    content: Use this guidance only for its curated interview families.
    interviewFamilies: [ai-ml-system-design, system-design]
\`\`\`` }, 100);
    const entry = parsed.entries[0];
    assert.ok(entry);
    const store = (input: MemoryEntry, rawFamilies?: string) => {
      const candidate = buildMemoryEntryCandidate(input);
      if (rawFamilies !== undefined) candidate.content.interview_families = rawFamilies;
      db.prepare("INSERT OR IGNORE INTO memory_entries (id, enabled, created_at, updated_at, current_content_revision) VALUES (?,1,1,1,NULL)").run(input.id);
      const next = db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM memory_entry_revisions WHERE entry_id=?").get(input.id) as {revision:number};
      const fields = Object.keys(candidate.content);
      db.prepare(`INSERT INTO memory_entry_revisions (entry_id, revision, content_hash, source_revisions_json, created_at, ${fields.join(",")}) VALUES (?, ?, ?, '{}', 1, ${fields.map(() => "?").join(",")})`).run(input.id, next.revision, `fixture-${next.revision}`, ...Object.values(candidate.content));
      db.prepare("UPDATE memory_entries SET current_content_revision=? WHERE id=?").run(next.revision, input.id);
      return next.revision;
    };
    const read = (input: MemoryEntry) => {
      const row = db.prepare("SELECT r.interview_families FROM memory_entries e JOIN memory_entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_content_revision WHERE e.id=?").get(input.id) as { interview_families: string | null };
      return hydratePersistedMemoryInterviewFamilies(input, row.interview_families);
    };
    store(entry);
    const hydrated = read(entry);
    assert.deepEqual(hydrated.entry.interviewFamilies, ["ai-ml-system-design", "system-design"]);
    assert.equal(resolveMemoryInterviewFamilies(hydrated.entry).source, "explicit");
    for (const [questionType, family] of [["general-system-design", "system-design"], ["ai-ml-system-design", "ai-ml-system-design"]] as const) {
      assert.equal(resolveMemoryInterviewFamilyGateDecision({ entry: hydrated.entry, questionType, memoryPolicy: { id: family, allowedFamilies: [family] } }).rejectReason, undefined);
    }
    store({ ...entry, interviewFamilies: ["behavioral"] });
    assert.deepEqual(read(entry).entry.interviewFamilies, ["behavioral"]);
    const old = db.prepare("SELECT interview_families FROM memory_entry_revisions WHERE entry_id=? AND revision=1").get(entry.id) as {interview_families:string};
    assert.deepEqual(JSON.parse(old.interview_families), ["ai-ml-system-design", "system-design"]);
    const legacy: MemoryEntry = { ...entry, id: "legacy", title: "Coding algorithm guide", tags: ["coding"], interviewFamilies: undefined };
    store(legacy);
    assert.equal(read(legacy).interviewFamiliesStatus, "missing");
    store(legacy, "not-json");
    assert.equal(read(legacy).interviewFamiliesStatus, "malformed");
    assert.deepEqual(resolveMemoryInterviewFamilies(read(legacy).entry).families, ["coding"]);
    assert.throws(() => db.prepare("UPDATE memory_entry_revisions SET interview_families='[]' WHERE entry_id=?").run(entry.id), /immutable/);
  } finally { db.close(); }
});
