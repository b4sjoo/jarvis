export const recentSourceContextRuntimeScenarios = {
  sameTypeIndependent: {
    first: {
      id: "turn-first-design",
      text: "Design a URL shortener.",
      startedAt: 1_000,
      endedAt: 2_000,
    },
    second: {
      id: "turn-second-design",
      text: "Design a ride-sharing service.",
      startedAt: 35_000,
      endedAt: 36_000,
    },
  },
  aiMlToCodingChild: {
    parent: {
      id: "turn-rag-parent",
      text: "Design an enterprise RAG system.",
      startedAt: 1_000,
      endedAt: 2_000,
    },
    setup: {
      id: "turn-rag-constraint",
      text: "The corpus has per-tenant access control lists.",
      startedAt: 10_000,
      endedAt: 11_000,
    },
    ask: {
      id: "turn-coding-child",
      text: "Within this RAG system, implement the retrieval merge function in Python.",
      startedAt: 36_000,
      endedAt: 37_000,
    },
  },
  longOpenSourceGroup: [
    {
      id: "turn-long-1",
      text: "The service receives documents from many tenants.",
      startedAt: 1_000,
      endedAt: 2_000,
    },
    {
      id: "turn-long-2",
      text: "Each tenant has a separate access control policy.",
      startedAt: 42_000,
      endedAt: 43_000,
    },
    {
      id: "turn-long-3",
      text: "The index must remain available during regional failures.",
      startedAt: 83_000,
      endedAt: 84_000,
    },
    {
      id: "turn-long-4",
      text: "The read path has a two hundred millisecond latency target.",
      startedAt: 124_000,
      endedAt: 125_000,
    },
  ],
  terminalAsk: {
    id: "turn-long-ask",
    text: "How would you design the indexing and serving path?",
    startedAt: 150_000,
    endedAt: 151_000,
  },
  expiredSetup: {
    id: "turn-expired-setup",
    text: "The service processes private customer documents.",
    startedAt: 1_000,
    endedAt: 2_000,
  },
  expiredAsk: {
    id: "turn-expired-ask",
    text: "How would you secure the retrieval path?",
    startedAt: 48_000,
    endedAt: 49_000,
  },
  filler: {
    id: "turn-filler",
    text: "Mm, okay.",
    startedAt: 38_000,
    endedAt: 38_500,
  },
} as const;
