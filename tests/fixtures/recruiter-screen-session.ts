import type { CanonicalQuestionType } from "../../src/lib/meeting/task-taxonomy.js";
import type { InterviewTaskRelation } from "../../src/lib/meeting/types.js";

export const RECORDED_RECRUITER_SPEECH_BIAS_PROMPT =
  'Likely technical terms, company names, product names, and acronyms: Snowflake, RAG failure modes and fixes, Context engineering failure modes, Agent skills, MCP, and progressive disclosure, ML Commons Platform Smaller Features, RAG, MCP, ML, APIs, Retrieval-Augmented Generation, LLM, embedding, vector database, model serving, inference, evaluation, AI. Preserve acronyms and product names exactly. Corrections: "rec" means "RAG"; "rack" means "RAG".';

export type RecruiterRegressionDisposition =
  | "advisor"
  | "append-only"
  | "rejected";

export interface RecruiterRegressionTurnFixture {
  id: string;
  text: string;
  expectedDisposition: RecruiterRegressionDisposition;
  expectedQuestionType?: CanonicalQuestionType;
  expectedRelation?: InterviewTaskRelation;
  expectedModelRoute?: "main" | "coding-override";
  legacyObservedQuestionType?: CanonicalQuestionType;
  answerOutput?: string;
}

export const RECRUITER_SCREEN_REGRESSION_FIXTURE = {
  source: "sanitized-2026-07-15-recruiter-session",
  parentId: "parent_recruiter_project",
  project: {
    id: "production-ai-platform",
    name: "Production AI Platform",
    evidenceEntryId: "mem_production_ai_platform",
  },
  memoryEntries: [
    {
      id: "mem_production_ai_platform",
      type: "project_context" as const,
      title: "Production AI Platform evidence",
      content:
        "Shipped a backend API for a production AI product and owned concrete backend integration work.",
      projectId: "production-ai-platform",
      projectName: "Production AI Platform",
    },
    {
      id: "mem_testing_guidance",
      type: "field_note" as const,
      title: "Production testing guidance",
      content:
        "Potential techniques include manual checks, load testing, automated suites, and canary deployments. Treat these as options, not personal facts.",
    },
    {
      id: "mem_recruiter_answer_template",
      type: "answer_template" as const,
      title: "Recruiter project answer template",
      content: "State scope, personal contribution, concrete mechanism, and impact.",
    },
    {
      id: "mem_unrelated_project",
      type: "project_context" as const,
      title: "Unrelated project evidence",
      content: "Evidence for a different project that must not replace the binding.",
      projectId: "unrelated-search-tool",
      projectName: "Unrelated Search Tool",
    },
  ],
  turns: [
    {
      id: "project-opening",
      text:
        "Have you shipped a backend component or API for an AI product to production, and did that product involve LLMs?",
      expectedDisposition: "advisor",
      expectedQuestionType: "project-deep-dive",
      expectedRelation: "new-parent",
      expectedModelRoute: "main",
      answerOutput: [
        "中文思路: 先说明真实项目、生产范围和个人职责。",
        "Reply: I shipped a backend API for a production AI product and owned the backend integration boundary.",
        "Clarifying question: -",
      ].join("\n\n"),
    },
    {
      id: "personal-contribution",
      text:
        "When you were building that out, what was your specific personal contribution to the stack? Were you on the prompt side, or building the structural backend and APIs?",
      expectedDisposition: "advisor",
      expectedQuestionType: "project-deep-dive",
      expectedRelation: "followup-parent",
      expectedModelRoute: "main",
      legacyObservedQuestionType: "coding",
      answerOutput: [
        "中文思路: 聚焦个人负责的后端边界，避免扩大到没有证据的工作。",
        "Reply: My contribution centered on the backend API and its integration contract.",
        "Clarifying question: -",
      ].join("\n\n"),
    },
    {
      id: "backend-systems",
      text:
        "What functionality did your API provide, and what backend systems, key-value stores, vector databases, or caching layers did you use for latency and scale?",
      expectedDisposition: "advisor",
      expectedQuestionType: "project-deep-dive",
      expectedRelation: "followup-parent",
      expectedModelRoute: "main",
      legacyObservedQuestionType: "coding",
      answerOutput: [
        "中文思路: 只解释有项目证据支持的 API 职责和系统边界。",
        "Reply: The API exposed the production integration boundary; I would separate verified implementation details from architecture options I did not personally use.",
        "Clarifying question: -",
      ].join("\n\n"),
    },
    {
      id: "production-testing",
      text:
        "How did you test your backend before production? Was it manual spot checks, high-concurrency load testing, automated suites, or canary deployments?",
      expectedDisposition: "advisor",
      expectedQuestionType: "project-deep-dive",
      expectedRelation: "followup-parent",
      expectedModelRoute: "main",
      legacyObservedQuestionType: "coding",
      answerOutput: [
        "中文思路: 问题里的测试选项不等于做过这些测试，只回答已有事实。",
        "Reply: I would describe only the validation work supported by the project record and clarify any missing rollout detail.",
        "Clarifying question: -",
      ].join("\n\n"),
    },
    {
      id: "stakeholders",
      text:
        "Who were your primary day-to-day partners and stakeholders on the project?",
      expectedDisposition: "advisor",
      expectedQuestionType: "project-deep-dive",
      expectedRelation: "followup-parent",
      expectedModelRoute: "main",
      legacyObservedQuestionType: "coding",
      answerOutput: [
        "中文思路: 保持同一项目，只使用可验证的合作关系。",
        "Reply: I would name only stakeholders supported by the project evidence and explain the working boundary concretely.",
        "Clarifying question: -",
      ].join("\n\n"),
    },
    {
      id: "speech-bias-prompt-echo",
      text: RECORDED_RECRUITER_SPEECH_BIAS_PROMPT,
      expectedDisposition: "rejected",
    },
    {
      id: "closing-logistics",
      text:
        "Thank you for answering my questions. The next steps are a coding interview and a separate technical project interview, and I will send preparation material.",
      expectedDisposition: "append-only",
      expectedRelation: "logistics",
    },
  ] satisfies RecruiterRegressionTurnFixture[],
} as const;
