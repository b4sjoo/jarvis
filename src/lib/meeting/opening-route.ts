import type {
  MemoryAskFrame,
  MemoryQuestionType,
  MemoryTopicDomain,
} from "../memory";
import type { OpeningRouteContext } from "./types";

export interface DetectedOpeningTaskRoute extends OpeningRouteContext {
  questionType: MemoryQuestionType;
  askFrame: MemoryAskFrame;
  topicDomain: MemoryTopicDomain;
  explicitProjectIdentity: boolean;
}

const DIRECT_OPENING_REQUEST =
  /\b(?:tell me|walk me through|take me through|give me|share|describe|explain|talk about|hear about|i d love to hear|i would love to hear|i d like to hear|i would like to hear)\b/i;

const SELF_INTRO_REQUEST =
  /\b(?:introduce yourself|tell me about yourself|about yourself|start with your background|briefly introduce yourself)\b/i;

const PERSONAL_BACKGROUND =
  /\b(?:your (?:resume|background|career|journey)|background (?:about|across|over) your|your (?:time|years?) (?:at|with|in)|what you (?:have|ve) been up to|your (?:last|past) [a-z0-9-]+ years?|over the past [a-z0-9-]+ years?)\b/i;

const PROJECT_PORTFOLIO =
  /\b(?:your (?:work|projects)|projects? you (?:have|ve|had) worked on|work (?:that )?you (?:have|ve|had)? ?done|work you did|what (?:kind of )?(?:work|projects) (?:have )?you|what (?:have you|did you) (?:work on|build)|what you (?:built|worked on))\b/i;

const CANDIDATE_PROJECT_OBJECT =
  /\b(?:your (?:technical )?(?:project|system|feature)|(?:project|system|feature) you (?:built|designed|implemented|owned|led|worked on)|project you (?:are|re) proud of)\b/i;

const NAMED_PROJECT_OBJECT = /\b(?:project|system|feature)\b/i;

const PROJECT_DETAIL_REQUEST =
  /\b(?:technical difficult|technical challenge|hardest part|key tradeoff|why did you choose|how did you build|how did you design|how did you implement)\b/i;

export function detectOpeningTaskRoute(
  text: string
): DetectedOpeningTaskRoute | undefined {
  const normalized = normalizeOpeningRouteText(text);
  if (!normalized) return undefined;

  const projectAnchor = inferOpeningProjectAnchor(text);
  const asksSelfIntro = SELF_INTRO_REQUEST.test(normalized);
  const asksResumeWalkthrough =
    DIRECT_OPENING_REQUEST.test(normalized) &&
    PERSONAL_BACKGROUND.test(normalized);
  const hasCandidateProjectObject =
    CANDIDATE_PROJECT_OBJECT.test(normalized);
  const hasNamedProjectObject = Boolean(
    projectAnchor && NAMED_PROJECT_OBJECT.test(normalized)
  );
  const explicitProjectIdentity = Boolean(
    hasCandidateProjectObject ||
      (projectAnchor && /\bproject\b/i.test(normalized))
  );
  const asksProjectIntro =
    (DIRECT_OPENING_REQUEST.test(normalized) ||
      PROJECT_DETAIL_REQUEST.test(normalized)) &&
    (hasCandidateProjectObject || hasNamedProjectObject);
  const asksProjectPortfolio =
    (DIRECT_OPENING_REQUEST.test(normalized) ||
      /\bwhat (?:kind of )?(?:work|projects)\b/i.test(normalized) ||
      /\bwhat (?:have you|did you) (?:work on|build)\b/i.test(normalized)) &&
    PROJECT_PORTFOLIO.test(normalized);

  if (
    !asksSelfIntro &&
    !asksResumeWalkthrough &&
    !asksProjectIntro &&
    !asksProjectPortfolio
  ) {
    return undefined;
  }

  const kind = asksSelfIntro
    ? "self-intro"
    : asksResumeWalkthrough
      ? "resume-walkthrough"
      : asksProjectIntro
        ? "project-intro"
        : "project-portfolio";

  return {
    questionType: "project-deep-dive",
    askFrame: "past-project",
    topicDomain: inferOpeningTopicDomain(projectAnchor, text),
    projectAnchor,
    explicitProjectIdentity,
    kind,
    source:
      kind === "self-intro" || kind === "resume-walkthrough"
        ? "opening-route-self-intro"
        : kind === "project-portfolio"
          ? "opening-route-project-portfolio"
          : "opening-route-project-intro",
    commitParent: false,
  };
}

export function canOpeningRouteOwnCanonicalProjectParent(input: {
  route: DetectedOpeningTaskRoute | undefined;
  hasActiveParent: boolean;
  explicitTaskBoundary?: boolean;
  concreteQuestionType?: MemoryQuestionType;
}) {
  const route = input.route;
  if (
    route?.kind !== "project-intro" ||
    !route.projectAnchor ||
    !route.explicitProjectIdentity ||
    route.questionType !== "project-deep-dive"
  ) {
    return false;
  }
  if (
    input.concreteQuestionType &&
    input.concreteQuestionType !== "unknown" &&
    input.concreteQuestionType !== "project-deep-dive"
  ) {
    return false;
  }

  return !input.hasActiveParent || input.explicitTaskBoundary === true;
}

export function inferOpeningProjectAnchor(text: string) {
  const normalized = normalizeOpeningRouteText(text);
  const anchors: Array<[RegExp, string]> = [
    [/\bagentic memory\b/i, "Agentic Memory"],
    [/\bmodel interface\b/i, "Model Interface"],
    [/\bmanaged semantic search\b/i, "Managed Semantic Search"],
    [/\bsemantic search\b/i, "Managed Semantic Search"],
    [/\bthrottling\b|\bquota\b|\brate limit/i, "Throttling"],
    [/\boasis\b/i, "Oasis"],
    [/\bneural search\b|\bneuralsearch\b/i, "NeuralSearch"],
    [/\bbeaglestone\b/i, "BeagleStone Migration"],
    [/\baos release\b|\bopensearch release\b/i, "AOS Release"],
    [/\bml commons\b/i, "ML Commons"],
  ];

  for (const [pattern, anchor] of anchors) {
    if (pattern.test(normalized) || pattern.test(text)) return anchor;
  }

  return undefined;
}

export function inferOpeningTopicDomain(
  projectAnchor: string | undefined,
  text: string
): MemoryTopicDomain {
  const normalized = normalizeOpeningRouteText(
    `${projectAnchor ?? ""} ${text}`
  );
  if (/\b(agentic|memory|llm|model|ml|ai|rag|semantic|neural)\b/i.test(normalized)) {
    return "ai-ml-infra";
  }
  if (/\b(search|opensearch|aos)\b/i.test(normalized)) return "search";
  if (/\b(throttling|quota|rate limit|backend|service)\b/i.test(normalized)) {
    return "backend";
  }
  if (/\b(distributed|cluster|migration|storage|database)\b/i.test(normalized)) {
    return "backend";
  }
  return "unknown";
}

function normalizeOpeningRouteText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.()]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
