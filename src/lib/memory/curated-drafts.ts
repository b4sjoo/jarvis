import agenticMemoryDraft from "../../../docs/curated-memory-draft-agentic-memory.md?raw";
import behavioralStoryCatalogDraft from "../../../docs/curated-memory-draft-behavioral-story-catalog.md?raw";
import interviewGuideDraft from "../../../docs/curated-memory-draft-interview-guide.md?raw";
import mlCommonsSmallFeaturesDraft from "../../../docs/curated-memory-draft-mlcommons-small-features.md?raw";
import modelSemanticBeaglestoneNeuralSearchDraft from "../../../docs/curated-memory-draft-model-semantic-beaglestone-neuralsearch.md?raw";
import throttlingOasisAosDraft from "../../../docs/curated-memory-draft-throttling-oasis-aos.md?raw";
import type { MemoryImportDraft } from "./types";

export const CURATED_MEMORY_DRAFTS: MemoryImportDraft[] = [
  {
    path: "docs/curated-memory-draft-throttling-oasis-aos.md",
    content: throttlingOasisAosDraft,
  },
  {
    path: "docs/curated-memory-draft-model-semantic-beaglestone-neuralsearch.md",
    content: modelSemanticBeaglestoneNeuralSearchDraft,
  },
  {
    path: "docs/curated-memory-draft-agentic-memory.md",
    content: agenticMemoryDraft,
  },
  {
    path: "docs/curated-memory-draft-mlcommons-small-features.md",
    content: mlCommonsSmallFeaturesDraft,
  },
  {
    path: "docs/curated-memory-draft-behavioral-story-catalog.md",
    content: behavioralStoryCatalogDraft,
  },
  {
    path: "docs/curated-memory-draft-interview-guide.md",
    content: interviewGuideDraft,
  },
];
