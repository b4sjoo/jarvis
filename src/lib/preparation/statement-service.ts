import type { InterviewProcessRepository } from "./interview-types.js";
import type {
  PreparationStatementDomain,
  PreparationStatementOwnership,
  PreparationStatementRepository,
  PreparationStatementStatus,
} from "./statement-types.js";

export function createPreparationStatementService(dependencies: {
  repository: PreparationStatementRepository;
  interviewProcesses: InterviewProcessRepository;
  now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;

  return {
    list(input: {
      processId: string;
      roundId?: string;
      statuses?: PreparationStatementStatus[];
    }) {
      return dependencies.repository.list(input);
    },

    get(processId: string, statementId: string) {
      return dependencies.repository.get(processId, statementId);
    },

    listEvents(processId: string, statementId: string) {
      return dependencies.repository.listEvents(processId, statementId);
    },

    async review(input: {
      processId: string;
      statementId: string;
      expectedRevision: number;
      status: Exclude<PreparationStatementStatus, "superseded">;
      domain?: PreparationStatementDomain;
      content?: string;
      ownership?: PreparationStatementOwnership;
      allowedWording?: string;
      prohibitedWording?: string[];
      allowedInterviewFamilies?: string[];
    }) {
      const process = await dependencies.interviewProcesses.getProcess(
        input.processId
      );
      if (!process) throw new Error("Interview process not found.");
      if (process.status !== "active") {
        throw new Error("Archived interview processes are read-only.");
      }
      const current = await dependencies.repository.get(
        input.processId,
        input.statementId
      );
      if (!current) throw new Error("Preparation statement not found.");
      if (current.revision !== input.expectedRevision) {
        throw new Error("This statement changed while it was being reviewed.");
      }
      const content = normalizeStatementContent(input.content ?? current.content);
      const domain = input.domain ?? current.domain;
      const ownership = input.ownership ?? current.ownership;
      const allowedWording = normalizeOptionalText(
        input.allowedWording ?? current.allowedWording
      );
      const prohibitedWording = normalizeTextList(
        input.prohibitedWording ?? current.prohibitedWording
      );
      const allowedInterviewFamilies = normalizeTextList(
        input.allowedInterviewFamilies ?? current.allowedInterviewFamilies
      );
      if (
        input.status === "confirmed" &&
        ["candidate-fact", "project-evidence"].includes(domain) &&
        ownership === "unresolved"
      ) {
        throw new Error(
          "Resolve ownership before confirming candidate or project evidence."
        );
      }
      const changed =
        content !== current.content ||
        domain !== current.domain ||
        ownership !== current.ownership ||
        allowedWording !== current.allowedWording ||
        !sameTextList(prohibitedWording, current.prohibitedWording) ||
        !sameTextList(
          allowedInterviewFamilies,
          current.allowedInterviewFamilies
        );
      const updated = await dependencies.repository.review({
        processId: input.processId,
        statementId: input.statementId,
        expectedRevision: input.expectedRevision,
        status: input.status,
        domain,
        content,
        normalizedContent: normalizeStatementKey(content),
        ownership,
        allowedWording,
        prohibitedWording,
        allowedInterviewFamilies,
        authority:
          input.status === "confirmed" || changed
            ? "user-confirmed"
            : current.authority,
        action: input.status,
        revisionIncrement: changed ? 2 : 1,
        updatedAt: now(),
      });
      if (!updated) {
        throw new Error("This statement changed while it was being reviewed.");
      }
      return dependencies.repository.get(input.processId, input.statementId);
    },
  };
}

export function normalizeStatementContent(value: string) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Statement content is required.");
  if (normalized.length > 1_200) {
    throw new Error("A preparation statement must be 1,200 characters or less.");
  }
  return normalized;
}

export function normalizeStatementKey(value: string) {
  return normalizeStatementContent(value).toLocaleLowerCase("en-US");
}

function normalizeOptionalText(value: string | undefined) {
  const normalized = value?.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 1_200) : undefined;
}

function normalizeTextList(values: string[]) {
  return Array.from(
    new Set(
      values
        .map((value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim())
        .filter(Boolean)
        .map((value) => value.slice(0, 300))
    )
  ).slice(0, 20);
}

function sameTextList(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
