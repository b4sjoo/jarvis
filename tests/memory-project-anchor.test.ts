import assert from "node:assert/strict";
import test from "node:test";
import { isMemoryProjectAnchorCompatible } from "../src/lib/memory/project-anchor.js";
import type { MemoryEntry } from "../src/lib/memory/types.js";

test("strict project anchor requires multi-token project coverage", () => {
  const unrelatedMemoryEntry = makeMemoryEntry({
    id: "mem_unrelated_memory_cache",
    title: "Token bucket memory cache investigation",
    projectName: "Throttling",
    content:
      "Investigated a token bucket limiter and cache memory usage for request throttling.",
  });

  assert.equal(
    isMemoryProjectAnchorCompatible(unrelatedMemoryEntry, "Agentic Memory"),
    false
  );
});

test("strict project anchor accepts direct project name matches", () => {
  const agenticMemoryEntry = makeMemoryEntry({
    id: "mem_agentic_memory_arch",
    title: "Agentic Memory architecture",
    projectName: "Agentic Memory",
    content:
      "Designed two-phase extract-then-decide memory consolidation with strategy-specific mutation.",
  });

  assert.equal(
    isMemoryProjectAnchorCompatible(agenticMemoryEntry, "Agentic Memory"),
    true
  );
});

test("strict project anchor exempts global reusable guidance", () => {
  const globalRubric = makeMemoryEntry({
    id: "mem_project_deep_dive_framework",
    scope: "global",
    type: "interview_framework",
    title: "Project deep dive framework",
    content: "Use context, architecture, hard problem, tradeoff, validation, impact.",
  });

  assert.equal(
    isMemoryProjectAnchorCompatible(globalRubric, "Agentic Memory"),
    true
  );
});

function makeMemoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  const now = 1_779_000_000_000;
  return {
    id: "mem_1",
    sourceIds: [],
    type: "project_context",
    title: "Memory",
    content: "Memory content",
    scope: "project",
    tags: [],
    keywords: [],
    priority: "normal",
    enabled: true,
    injectionMode: "retrieval",
    useCases: ["meeting_assistant"],
    confidentiality: "normal",
    curationStatus: "curated",
    relatedEntryIds: [],
    evidenceEntryIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
