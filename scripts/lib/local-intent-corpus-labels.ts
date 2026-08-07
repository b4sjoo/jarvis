import type {
  CorpusHead,
  CorpusHeadResolution,
  CorpusLabelCandidate,
  CorpusLabelLedgerRow,
  CorpusReviewQueueItem,
  CorpusSplit,
} from "./local-intent-corpus-schema.js";
import { sha256 } from "./local-intent-corpus-utils.js";

const HEADS: CorpusHead[] = ["speech-act", "question-type", "phase-signal"];
const EVALUATION_SPLITS: CorpusSplit[] = [
  "train",
  "dev",
  "calibration",
  "sealed-test",
  "rolling-eval",
];

export function normalizeLabelCandidateDisposition(
  candidate: Omit<CorpusLabelCandidate, "disposition">
): CorpusLabelCandidate {
  let disposition: CorpusLabelCandidate["disposition"];
  if (candidate.authority === "generated-output") {
    disposition = "blocked";
  } else if (
    (candidate.authority === "human-confirmed" ||
      candidate.authority === "manual-correction") &&
    candidate.confirmation === "confirmed" &&
    candidate.sourceIntegrity === "complete" &&
    (candidate.sourceJoin === "exact-turn" ||
      candidate.sourceJoin === "exact-lqu")
  ) {
    disposition = "gold-candidate";
  } else if (
    candidate.authority === "runtime-observed" ||
    candidate.authority === "model-proposal"
  ) {
    disposition = "weak";
  } else if (candidate.authority === "legacy-human") {
    disposition = "review";
  } else if (
    candidate.sourceJoin === "timestamp" ||
    candidate.sourceJoin === "partial" ||
    candidate.sourceIntegrity !== "complete"
  ) {
    disposition = "review";
  } else {
    disposition = "blocked";
  }
  return { ...candidate, disposition };
}

export function buildCorpusLabelLedger(input: {
  exampleIds: string[];
  candidates: CorpusLabelCandidate[];
}) {
  const candidatesByExample = new Map<string, CorpusLabelCandidate[]>();
  for (const candidate of input.candidates) {
    const current = candidatesByExample.get(candidate.exampleId) ?? [];
    current.push(candidate);
    candidatesByExample.set(candidate.exampleId, current);
  }

  const ledger: CorpusLabelLedgerRow[] = [];
  const reviewQueue: CorpusReviewQueueItem[] = [];
  for (const exampleId of [...input.exampleIds].sort()) {
    const exampleCandidates = candidatesByExample.get(exampleId) ?? [];
    const heads = Object.fromEntries(
      HEADS.map((head) => {
        const resolution = resolveHead(
          head,
          exampleCandidates.filter((candidate) => candidate.head === head)
        );
        reviewQueue.push(
          ...resolution.reviewReasons.map((reason) =>
            createReviewItem({
              exampleId,
              head,
              reason,
              candidateIds: resolution.value.activeCandidateIds,
            })
          )
        );
        return [head, resolution.value];
      })
    ) as Record<CorpusHead, CorpusHeadResolution>;
    ledger.push({ schemaVersion: 1, exampleId, heads });
  }
  return {
    ledger,
    reviewQueue: dedupeReviewQueue(reviewQueue),
  };
}

function resolveHead(
  head: CorpusHead,
  candidates: CorpusLabelCandidate[]
): {
  value: CorpusHeadResolution;
  reviewReasons: CorpusReviewQueueItem["reason"][];
} {
  const gold = candidates.filter(
    (candidate) => candidate.disposition === "gold-candidate"
  );
  const weak = candidates.filter((candidate) => candidate.disposition === "weak");
  const blocked = candidates.filter(
    (candidate) =>
      candidate.disposition === "blocked" || candidate.disposition === "review"
  );
  const reviewReasons: CorpusReviewQueueItem["reason"][] = [];

  if (blocked.some((candidate) => candidate.sourceJoin === "timestamp")) {
    reviewReasons.push("timestamp-only-join");
  }
  if (
    blocked.some(
      (candidate) =>
        candidate.sourceJoin === "missing" || candidate.sourceJoin === "partial"
    )
  ) {
    reviewReasons.push("missing-source-join");
  }
  if (
    blocked.some(
      (candidate) =>
        candidate.sourceIntegrity === "unsealed" ||
        candidate.sourceIntegrity === "legacy-unverified"
    )
  ) {
    reviewReasons.push("unsealed-source");
  }
  if (blocked.some((candidate) => candidate.authority === "legacy-human")) {
    reviewReasons.push("legacy-taxonomy");
  }

  const goldKeys = distinctValues(gold);
  const weakKeys = distinctValues(weak);
  if (goldKeys.length > 1) {
    reviewReasons.push("gold-conflict");
    return {
      value: unresolved(head, candidates, ["gold-conflict"]),
      reviewReasons,
    };
  }
  if (goldKeys.length === 1) {
    const selected = gold.find((candidate) => candidateKey(candidate) === goldKeys[0]);
    if (weakKeys.some((key) => key !== goldKeys[0])) {
      reviewReasons.push("gold-weak-disagreement");
    }
    return {
      value: {
        head,
        state: "gold",
        value: selected?.value,
        applicability: selected?.applicability ?? "unresolved",
        activeCandidateIds: gold.map((candidate) => candidate.candidateId).sort(),
        blockerCodes: [],
        eligibleSplits: EVALUATION_SPLITS,
        lossEligible: selected?.applicability === "applicable",
      },
      reviewReasons,
    };
  }
  if (weakKeys.length > 1) {
    reviewReasons.push("weak-conflict");
    return {
      value: unresolved(head, candidates, ["weak-conflict"]),
      reviewReasons,
    };
  }
  if (weakKeys.length === 1) {
    const selected = weak[0];
    return {
      value: {
        head,
        state: "weak",
        value: selected.value,
        applicability: selected.applicability,
        activeCandidateIds: weak.map((candidate) => candidate.candidateId).sort(),
        blockerCodes: [],
        eligibleSplits: ["train"],
        lossEligible: selected.applicability === "applicable",
      },
      reviewReasons,
    };
  }
  if (blocked.length) {
    if (!reviewReasons.length) reviewReasons.push("missing-label");
    return {
      value: {
        head,
        state: "blocked",
        applicability: "unresolved",
        activeCandidateIds: blocked.map((candidate) => candidate.candidateId).sort(),
        blockerCodes: [...new Set(reviewReasons)].sort(),
        eligibleSplits: [],
        lossEligible: false,
      },
      reviewReasons,
    };
  }
  reviewReasons.push("missing-label");
  return {
    value: unresolved(head, [], ["missing-label"]),
    reviewReasons,
  };
}

function unresolved(
  head: CorpusHead,
  candidates: CorpusLabelCandidate[],
  blockerCodes: string[]
): CorpusHeadResolution {
  return {
    head,
    state: "unresolved",
    applicability: "unresolved",
    activeCandidateIds: candidates.map((candidate) => candidate.candidateId).sort(),
    blockerCodes,
    eligibleSplits: [],
    lossEligible: false,
  };
}

function distinctValues(candidates: CorpusLabelCandidate[]) {
  return [...new Set(candidates.map(candidateKey))].sort();
}

function candidateKey(candidate: CorpusLabelCandidate) {
  return `${candidate.applicability}:${candidate.value ?? ""}`;
}

function createReviewItem(input: {
  exampleId: string;
  head: CorpusHead;
  reason: CorpusReviewQueueItem["reason"];
  candidateIds: string[];
}): CorpusReviewQueueItem {
  const candidateIds = [...input.candidateIds].sort();
  return {
    schemaVersion: 1,
    itemId: sha256(
      [input.exampleId, input.head, input.reason, ...candidateIds].join("\0")
    ),
    exampleId: input.exampleId,
    head: input.head,
    reason: input.reason,
    priority:
      input.reason === "gold-conflict" || input.reason === "locked-split-merge"
        ? 0
        : input.reason === "missing-label" ||
            input.reason === "gold-weak-disagreement"
          ? 1
          : 2,
    candidateIds,
    status: "open",
  };
}

function dedupeReviewQueue(items: CorpusReviewQueueItem[]) {
  return [...new Map(items.map((item) => [item.itemId, item])).values()].sort(
    (left, right) =>
      left.priority - right.priority || left.itemId.localeCompare(right.itemId)
  );
}
