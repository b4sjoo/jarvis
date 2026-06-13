export type MemoryScope = "global" | "project";

export type MemoryCollection =
  | "profiles"
  | "project_docs"
  | "question_bank"
  | "interview_guide";

export type MemoryConfidentiality = "normal" | "sensitive" | "confidential";

export type MemorySourceCanonicality =
  | "canonical"
  | "supporting"
  | "evidence"
  | "stale";

export type RawInjectionPolicy =
  | "allow"
  | "summary_only"
  | "title_only"
  | "never";

export type MemoryCurationStatus =
  | "raw"
  | "extracted"
  | "curated"
  | "verified"
  | "stale";

export type MemorySourceFormat =
  | "markdown"
  | "txt"
  | "xml"
  | "diff"
  | "patch"
  | "plain_text"
  | "unknown";

export type MemorySourceOrigin = "manual" | "imported" | "generated";

export type MemorySourceRole =
  | "resume"
  | "promotion_doc"
  | "behavioral_bank"
  | "technical_question_bank"
  | "company_profile"
  | "leadership_principle_rubric"
  | "project_summary"
  | "design_doc"
  | "implementation_plan"
  | "implementation_tracker"
  | "investigation"
  | "working_summary"
  | "sop"
  | "release_doc"
  | "checklist"
  | "threat_model"
  | "api_guide"
  | "prompt_template"
  | "diagram_doc"
  | "code_patch"
  | "dev_context"
  | "misc";

export interface MemorySource {
  id: string;
  title: string;
  collection: MemoryCollection;
  sourceOrigin: MemorySourceOrigin;
  sourceFormat: MemorySourceFormat;
  sourceRole: MemorySourceRole;
  originalPath?: string;
  scope: MemoryScope;
  projectId?: string;
  projectName?: string;
  confidentiality: MemoryConfidentiality;
  canonicality: MemorySourceCanonicality;
  rawInjectionPolicy: RawInjectionPolicy;
  curationStatus: MemoryCurationStatus;
  checksum?: string;
  draftPath?: string;
  createdAt: number;
  updatedAt: number;
}

export type MemoryEntryType =
  | "profile"
  | "preference"
  | "resume_fact"
  | "personal_story"
  | "achievement_metric"
  | "answer_evidence"
  | "working_summary"
  | "project_context"
  | "design_doc"
  | "implementation_note"
  | "decision_record"
  | "investigation_note"
  | "threat_model"
  | "field_note"
  | "glossary"
  | "correction"
  | "interview_framework"
  | "behavioral_question"
  | "technical_question"
  | "coding_question"
  | "answer_template"
  | "cached_answer"
  | "evaluation_criteria"
  | "architecture_diagram"
  | "whiteboard_overlay";

export type MemoryInjectionMode =
  | "always"
  | "retrieval"
  | "manual_only"
  | "never";

export type MemoryUseCase =
  | "meeting_assistant"
  | "coding_interview"
  | "behavioral_interview"
  | "system_design_interview"
  | "aiml_system_design_interview"
  | "project_deep_dive"
  | "answer_alignment"
  | "general_chat";

export type MemoryInterviewType =
  | "behavioral"
  | "coding"
  | "system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "mixed";

export type MemoryInterviewFamily = Exclude<MemoryInterviewType, "mixed">;

export type MemoryQuestionType =
  | "behavioral"
  | "coding"
  | "system-design"
  | "general-system-design"
  | "ai-ml-system-design"
  | "project-deep-dive"
  | "field-knowledge"
  | "unknown";

export type MemoryAskFrame =
  | "hypothetical-design"
  | "past-project"
  | "ambiguous"
  | "direct-answer"
  | "unknown";

export type MemoryTopicDomain =
  | "ai-ml-infra"
  | "agentic-ai"
  | "search"
  | "backend"
  | "unknown";

export type MemoryPriority = "low" | "normal" | "high" | "pinned";

export interface MemoryEntry {
  id: string;
  sourceIds: string[];
  type: MemoryEntryType;
  title: string;
  content: string;
  summary?: string;
  scope: MemoryScope;
  projectId?: string;
  projectName?: string;
  tags: string[];
  keywords: string[];
  priority: MemoryPriority;
  enabled: boolean;
  injectionMode: MemoryInjectionMode;
  useCases: MemoryUseCase[];
  confidentiality: MemoryConfidentiality;
  curationStatus: MemoryCurationStatus;
  relatedEntryIds: string[];
  evidenceEntryIds: string[];
  draftPath?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface MemoryProject {
  id: string;
  name: string;
  scope: MemoryScope;
  entryCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryImportDraft {
  path: string;
  content: string;
}

export interface ParsedMemoryDraft {
  path: string;
  sources: MemorySource[];
  entries: MemoryEntry[];
  warnings: string[];
}

export interface MemoryImportSummary {
  importedAt: number;
  draftCount: number;
  sourceCount: number;
  entryCount: number;
  projectCount: number;
  warnings: string[];
}

export interface MemoryRetrievalRequest {
  query: string;
  useCase: MemoryUseCase;
  projectId?: string;
  interviewTypes?: MemoryInterviewType[];
  questionType?: MemoryQuestionType;
  askFrame?: MemoryAskFrame;
  topicDomain?: MemoryTopicDomain;
  projectAnchor?: string;
  memoryPolicy?: MemoryRetrievalPolicy;
  maxEntries?: number;
  maxChars?: number;
  perEntryMaxChars?: number;
}

export interface MemoryRetrievalPolicy {
  id: string;
  allowedFamilies?: MemoryInterviewFamily[];
  blockedFamilies?: MemoryInterviewFamily[];
  strictProjectAnchor?: string;
  maxEntries?: number;
  maxChars?: number;
  perEntryMaxChars?: number;
}

export type MemoryRejectReason =
  | "disabled"
  | "manual-or-never"
  | "uncurated"
  | "use-case-mismatch"
  | "brief-interview-type-blocked"
  | "playbook-family-blocked"
  | "question-type-family-mismatch"
  | "behavioral-family-blocked"
  | "diagram-overlay-question-type-blocked"
  | "project-anchor-mismatch"
  | "missing-required-tag-hint"
  | "no-retrieval-match"
  | "budget-truncated";

export interface MemoryRejectSummary {
  reason: MemoryRejectReason;
  count: number;
  sampleEntryIds: string[];
  sampleTitles: string[];
}

export interface MemoryPolicySnapshot {
  useCase: MemoryUseCase;
  interviewTypes?: MemoryInterviewType[];
  questionType?: MemoryQuestionType;
  askFrame?: MemoryAskFrame;
  topicDomain?: MemoryTopicDomain;
  projectAnchor?: string;
  memoryPolicyId?: string;
  allowedFamilies?: MemoryInterviewFamily[];
  blockedFamilies?: MemoryInterviewFamily[];
  strictProjectAnchor?: string;
  maxEntries: number;
  maxChars: number;
  perEntryMaxChars: number;
}

export interface RetrievedMemoryEntry {
  entry: MemoryEntry;
  score: number;
  matchReason: string[];
  injectedContent: string;
}

export interface MemoryRetrievalResult {
  entries: RetrievedMemoryEntry[];
  contextText: string;
  totalChars: number;
  candidateCount: number;
  eligibleCount: number;
  rejectedCount: number;
  rejectSummary: MemoryRejectSummary[];
  overlaySelection?: MemoryOverlaySelectionSummary;
  policySnapshot: MemoryPolicySnapshot;
}

export interface MemoryOverlaySelectionSummary {
  selectedEntryIds: string[];
  selectedTitles: string[];
  rejectedCount: number;
  rejectSummary: MemoryRejectSummary[];
}
