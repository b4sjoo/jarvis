interface CodingChildPlaybookLike {
  questionType: unknown;
  phase: unknown;
}

interface CodingChildPhaseStateLike {
  playbook: CodingChildPlaybookLike;
  phase: string;
  phaseProgress: Record<string, boolean>;
  revision: number;
}

export function createCodingChildPhaseState<
  TPlaybook extends CodingChildPlaybookLike,
>(input: {
  questionType: unknown;
  playbook?: TPlaybook;
}) {
  if (
    input.questionType !== "coding" ||
    input.playbook?.questionType !== "coding"
  ) {
    return undefined;
  }
  const phase = "implementation_validation" as const;
  return {
    playbook: { ...input.playbook, phase },
    phase,
    phaseProgress: { [phase]: true },
    revision: 1,
  };
}

export function preserveOrCreateCodingChildPhaseState<
  TPlaybook extends CodingChildPlaybookLike,
  TState extends CodingChildPhaseStateLike,
>(input: {
  questionType: unknown;
  existing?: TState;
  playbook?: TPlaybook;
}): TState | ReturnType<typeof createCodingChildPhaseState<TPlaybook>> {
  if (input.questionType !== "coding") return undefined;
  if (input.existing?.playbook.questionType === "coding") {
    return {
      ...input.existing,
      playbook: { ...input.existing.playbook },
      phaseProgress: { ...input.existing.phaseProgress },
    } as TState;
  }
  return createCodingChildPhaseState(input);
}
