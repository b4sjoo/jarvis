// Frozen generic code-question payloads and unmodified model outputs from the regression.
export const recordedLinkageOutputs = [
  {
    name: "matching LRU evidence",
    voiceQuestion: "Explain lines 31 through 37.",
    screenQuestion: "Implement LRU cache",
    screenEvidenceSummary: "Cursor is focused near line 34 ('node = self.cache[key]') inside 'def get(self, key: int) -> int:' of 'class LRUCache'. Surrounding methods include 'class Node', '_remove', '_add_front', and 'put'. Line 1 states 'Implment LRU cache'. Language mode is Python. Implement LRU cache",
    expectedDecision: "bind-voice",
    rawOutput: `\`\`\`json
{
  "schemaVersion": 1,
  "decision": "bind-voice",
  "voiceEvidenceSpans": [
    "lines 31 through 37"
  ],
  "screenEvidenceSummary": "Cursor is focused near line 34 ('node = self.cache[key]') inside 'def get(self, key: int) -> int:' of 'class LRUCache'.",
  "screenEvidenceSpans": [
    "node = self.cache[key]",
    "def get(self, key: int) -> int:"
  ]
}
\`\`\``,
  },
  {
    name: "independent merge sort",
    voiceQuestion: "Explain lines 60-70",
    screenQuestion: "Implement merge sort",
    screenEvidenceSummary: "Line 1 in Untitled-1 reads 'Implment merge sort' with cursor located at the end of the line. Status bar indicates Python environment. Implement merge sort",
    expectedDecision: "use-screen",
    rawOutput: `\`\`\`json
{
  "schemaVersion": 1,
  "decision": "use-screen",
  "voiceEvidenceSpans": [
    "Explain lines 60-70"
  ],
  "screenEvidenceSummary": "Line 1 in Untitled-1 reads 'Implment merge sort' with cursor located at the end of the line. Status bar indicates Python environment. Implement merge sort",
  "screenEvidenceSpans": [
    "Line 1 in Untitled-1 reads 'Implment merge sort' with cursor located at the end of the line."
  ]
}
\`\`\``,
  },
] as const;
