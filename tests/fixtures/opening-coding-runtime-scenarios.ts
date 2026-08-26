export type OpeningCodingResponseOutcome =
  | "output-request"
  | "timeout"
  | "invalid"
  | "no-output-request";

export interface OpeningCodingRuntimeScenario {
  id: string;
  input: {
    text: string;
    responseOutcome: OpeningCodingResponseOutcome;
  };
  expected: {
    runtimeAction: "advise" | "suppress";
    questionType?: "coding";
    relation?: "new-parent";
    parentAction?: "create";
    requestedArtifacts: Array<"answer">;
  };
}

const openingCodingText =
  "Now let's do a coding question. Please implement an LRU cache with O(1) complexity, get and put, in Python.";

export const openingCodingRuntimeScenarios: OpeningCodingRuntimeScenario[] = [
  {
    id: "opening-coding-response-output",
    input: { text: openingCodingText, responseOutcome: "output-request" },
    expected: {
      runtimeAction: "advise",
      questionType: "coding",
      relation: "new-parent",
      parentAction: "create",
      requestedArtifacts: ["answer"],
    },
  },
  {
    id: "opening-coding-response-timeout",
    input: { text: openingCodingText, responseOutcome: "timeout" },
    expected: {
      runtimeAction: "advise",
      questionType: "coding",
      relation: "new-parent",
      parentAction: "create",
      requestedArtifacts: ["answer"],
    },
  },
  {
    id: "opening-coding-response-invalid",
    input: { text: openingCodingText, responseOutcome: "invalid" },
    expected: {
      runtimeAction: "advise",
      questionType: "coding",
      relation: "new-parent",
      parentAction: "create",
      requestedArtifacts: ["answer"],
    },
  },
  {
    id: "opening-coding-response-no-output",
    input: { text: openingCodingText, responseOutcome: "no-output-request" },
    expected: { runtimeAction: "suppress", requestedArtifacts: [] },
  },
];

export const openingCodingRuntimeNegativeControls = [
  { id: "bare-language-constraint", text: "In Python." },
  { id: "exact-acknowledgement", text: "Mm, okay." },
] as const;
