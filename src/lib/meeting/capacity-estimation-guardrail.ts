import {
  normalizeCanonicalQuestionType,
  type CanonicalQuestionType,
} from "./task-taxonomy.js";

export type CapacityEstimationDisposition =
  | "not-applicable"
  | "direct-throughput"
  | "derivable-time-basis"
  | "missing-time-basis"
  | "no-capacity-evidence";

export interface CapacityEstimationGuardrailDecision {
  disposition: CapacityEstimationDisposition;
  questionType?: CanonicalQuestionType;
  hasDirectThroughput: boolean;
  hasTimeBasedVolume: boolean;
  hasActorPopulation: boolean;
  hasPerActorCadence: boolean;
  hasIntervalCadence: boolean;
  hasInventory: boolean;
  hasTrafficRatio: boolean;
  hasPeakFactor: boolean;
  numericQpsAuthorized: boolean;
}

const SCALED_NUMBER = String.raw`\d+(?:\.\d+)?\s*(?:k|m|b|thousand|million|billion)?`;

export function resolveCapacityEstimationGuardrail(input: {
  questionType?: string;
  sourceText?: string;
}): CapacityEstimationGuardrailDecision {
  const questionType = normalizeCanonicalQuestionType(input.questionType);
  const text = input.sourceText?.trim().toLowerCase() ?? "";
  const applicable = questionType === "general-system-design";
  const hasDirectThroughput = matches(text, [
    new RegExp(
      String.raw`\b${SCALED_NUMBER}\s*(?:qps|tps|rps|queries per second|requests per second|reads per second|writes per second)\b`,
      "i"
    ),
    /(?:每秒|秒级)\s*\d+(?:\.\d+)?\s*(?:万|亿)?\s*(?:请求|查询|读|写|事件)/u,
  ]);
  const hasTimeBasedVolume = matches(text, [
    new RegExp(
      String.raw`\b${SCALED_NUMBER}\s*(?:requests?|queries|reads?|writes?|events?|operations?|actions?|rides?|orders?)\s*(?:per|/)\s*(?:second|sec|minute|min|hour|day|week|month)\b`,
      "i"
    ),
    new RegExp(
      String.raw`\b(?:daily|hourly|weekly|monthly)\s+(?:traffic|volume|requests?|queries|reads?|writes?|events?|operations?|actions?)\s*(?:of|is|=|:)?\s*${SCALED_NUMBER}\b`,
      "i"
    ),
    /(?:每天|每日|每小时|每分钟|每月)\s*\d+(?:\.\d+)?\s*(?:万|亿)?\s*(?:请求|查询|读|写|事件|操作)/u,
  ]);
  const hasActorPopulation = matches(text, [
    new RegExp(
      String.raw`\b${SCALED_NUMBER}\s*(?:users?|dau|mau|daily active users?|monthly active users?|devices?|clients?)\b`,
      "i"
    ),
    /\d+(?:\.\d+)?\s*(?:万|亿)?\s*(?:用户|日活|月活|设备|客户端)/u,
  ]);
  const hasPerActorCadence = matches(text, [
    new RegExp(
      String.raw`\b${SCALED_NUMBER}\s*(?:requests?|queries|reads?|writes?|events?|operations?|actions?|rides?|orders?)\s*(?:per|/)\s*(?:user|device|client)\s*(?:per|/)\s*(?:second|minute|hour|day|week|month)\b`,
      "i"
    ),
    /(?:每个|每位)\s*(?:用户|设备|客户端).{0,24}(?:每天|每日|每小时|每分钟)\s*\d+(?:\.\d+)?\s*(?:次|个)?(?:请求|查询|读|写|事件|操作)?/u,
  ]);
  const hasIntervalCadence = matches(text, [
    /\b(?:one|1)\s+(?:request|query|read|write|event|operation|action|update)?\s*every\s+\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?)\b/i,
    /\bevery\s+\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?)\b/i,
    /每隔\s*\d+(?:\.\d+)?\s*(?:秒|分钟|小时)/u,
  ]);
  const hasInventory = matches(text, [
    new RegExp(
      String.raw`\b${SCALED_NUMBER}\s*(?:urls?|items?|objects?|records?|rows?|documents?|files?|photos?|videos?|products?)\b`,
      "i"
    ),
    /\d+(?:\.\d+)?\s*(?:万|亿)?\s*(?:条|个|份)?(?:url|链接|对象|记录|文档|文件|图片|视频|商品)/u,
  ]);
  const hasTrafficRatio = matches(text, [
    /\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/,
    /\b(?:read\s*\/\s*write|read[- ]to[- ]write|write\s*\/\s*read|write[- ]to[- ]read)\s+ratio\b/i,
    /读写比|写读比/u,
  ]);
  const hasPeakFactor = matches(text, [
    /\b(?:peak factor|peak multiplier|peak is|at peak)\b/i,
    /\b\d+(?:\.\d+)?\s*x\s*(?:peak|average)\b/i,
    /峰值(?:系数|倍数)?/u,
  ]);

  const evidence = {
    questionType,
    hasDirectThroughput,
    hasTimeBasedVolume,
    hasActorPopulation,
    hasPerActorCadence,
    hasIntervalCadence,
    hasInventory,
    hasTrafficRatio,
    hasPeakFactor,
  };
  if (!applicable) {
    return {
      ...evidence,
      disposition: "not-applicable",
      numericQpsAuthorized: false,
    };
  }
  if (hasDirectThroughput) {
    return {
      ...evidence,
      disposition: "direct-throughput",
      numericQpsAuthorized: true,
    };
  }
  if (
    hasTimeBasedVolume ||
    (hasActorPopulation && (hasPerActorCadence || hasIntervalCadence))
  ) {
    return {
      ...evidence,
      disposition: "derivable-time-basis",
      numericQpsAuthorized: true,
    };
  }
  if (
    hasActorPopulation ||
    hasInventory ||
    hasTrafficRatio ||
    hasPeakFactor ||
    /\b(?:estimate|calculate|derive)\s+(?:the\s+)?(?:peak\s+)?qps\b/i.test(text)
  ) {
    return {
      ...evidence,
      disposition: "missing-time-basis",
      numericQpsAuthorized: false,
    };
  }
  return {
    ...evidence,
    disposition: "no-capacity-evidence",
    numericQpsAuthorized: false,
  };
}

export function formatCapacityEstimationGuardrailForPrompt(
  decision: CapacityEstimationGuardrailDecision
) {
  if (decision.disposition === "not-applicable") {
    return "Not applicable to the current canonical question type.";
  }
  const evidence = [
    decision.hasDirectThroughput ? "direct-throughput" : undefined,
    decision.hasTimeBasedVolume ? "time-based-volume" : undefined,
    decision.hasActorPopulation ? "actor-population" : undefined,
    decision.hasPerActorCadence ? "per-actor-cadence" : undefined,
    decision.hasIntervalCadence ? "interval-cadence" : undefined,
    decision.hasInventory ? "inventory" : undefined,
    decision.hasTrafficRatio ? "traffic-ratio" : undefined,
    decision.hasPeakFactor ? "peak-factor" : undefined,
  ].filter(Boolean);
  const instruction = decision.numericQpsAuthorized
    ? "Numeric QPS may be calculated only from the supplied time basis. Keep average, peak, read, and write QPS distinct and label every added assumption."
    : decision.disposition === "missing-time-basis"
      ? "Do not emit a numeric QPS range. Inventory, user count, read/write ratio, or peak factor alone does not determine throughput. Ask for requests/actions per time window, or state an explicit mutable time-basis assumption before calculating."
      : "No numeric capacity evidence is available. Ask for DAU plus actions per user per day and a peak factor, or for requests per time window, before estimating QPS.";
  return [
    `Disposition: ${decision.disposition}`,
    `Numeric QPS authorized: ${decision.numericQpsAuthorized}`,
    `Observed evidence: ${evidence.join(", ") || "none"}`,
    `Instruction: ${instruction}`,
  ].join("\n");
}

export function formatCapacityEstimationGuardrailForTrace(
  decision: CapacityEstimationGuardrailDecision
) {
  return {
    capacityEstimationDisposition: decision.disposition,
    capacityEstimationNumericQpsAuthorized:
      decision.numericQpsAuthorized,
    capacityEstimationHasDirectThroughput:
      decision.hasDirectThroughput,
    capacityEstimationHasTimeBasedVolume:
      decision.hasTimeBasedVolume,
    capacityEstimationHasActorPopulation:
      decision.hasActorPopulation,
    capacityEstimationHasPerActorCadence:
      decision.hasPerActorCadence,
    capacityEstimationHasIntervalCadence:
      decision.hasIntervalCadence,
    capacityEstimationHasInventory: decision.hasInventory,
    capacityEstimationHasTrafficRatio: decision.hasTrafficRatio,
    capacityEstimationHasPeakFactor: decision.hasPeakFactor,
  };
}

function matches(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}
