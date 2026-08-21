import agenticMemoryDraft from "../../../docs/curated-memory-draft-agentic-memory.md?raw";
import behavioralStoryCatalogDraft from "../../../docs/curated-memory-draft-behavioral-story-catalog.md?raw";
import interviewGuideDraft from "../../../docs/curated-memory-draft-interview-guide.md?raw";
import mlCommonsSmallFeaturesDraft from "../../../docs/curated-memory-draft-mlcommons-small-features.md?raw";
import modelSemanticBeaglestoneNeuralSearchDraft from "../../../docs/curated-memory-draft-model-semantic-beaglestone-neuralsearch.md?raw";
import throttlingOasisAosDraft from "../../../docs/curated-memory-draft-throttling-oasis-aos.md?raw";
import type { MemoryImportDraft } from "./types";
import { CURATED_MEMORY_DRAFT_PATHS } from "./curated-draft-paths";

const CURATED_MEMORY_DRAFT_CONTENTS = [
  throttlingOasisAosDraft,
  modelSemanticBeaglestoneNeuralSearchDraft,
  agenticMemoryDraft,
  mlCommonsSmallFeaturesDraft,
  behavioralStoryCatalogDraft,
  interviewGuideDraft,
];

export const CURATED_MEMORY_DRAFTS: MemoryImportDraft[] =
  CURATED_MEMORY_DRAFT_PATHS.map((path, index) => ({
    path,
    content: CURATED_MEMORY_DRAFT_CONTENTS[index] ?? "",
  }));
