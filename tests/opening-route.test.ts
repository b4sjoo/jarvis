import assert from "node:assert/strict";
import test from "node:test";
import {
  canOpeningRouteOwnCanonicalProjectParent,
  detectOpeningTaskRoute,
} from "../src/lib/meeting/opening-route.js";

test("recognizes natural recruiter resume and project portfolio openings", () => {
  const cases = [
    {
      text: "I would love to hear about the work that you've done there.",
      kind: "project-portfolio",
      commitParent: false,
    },
    {
      text: "Can you give me a little bit of background about your four years and what you've been up to recently?",
      kind: "resume-walkthrough",
      commitParent: false,
    },
    {
      text: "What kind of work have you done at AWS?",
      kind: "project-portfolio",
      commitParent: false,
    },
    {
      text: "Walk me through your career and your time at OpenSearch.",
      kind: "resume-walkthrough",
      commitParent: false,
    },
  ] as const;

  for (const scenario of cases) {
    const route = detectOpeningTaskRoute(scenario.text);
    assert.equal(route?.kind, scenario.kind, scenario.text);
    assert.equal(route?.commitParent, scenario.commitParent, scenario.text);
    assert.equal(route?.questionType, "project-deep-dive", scenario.text);
    assert.equal(route?.askFrame, "past-project", scenario.text);
  }
});

test("keeps opening frames non-mutating until runtime authorizes the parent", () => {
  const selfIntro = detectOpeningTaskRoute(
    "Before we begin, could you briefly introduce yourself?"
  );
  const projectIntro = detectOpeningTaskRoute(
    "Tell me about your Agentic Memory project and its hardest technical challenge."
  );
  const selectedProject = detectOpeningTaskRoute(
    "Tell me about a project you are proud of."
  );

  assert.equal(selfIntro?.kind, "self-intro");
  assert.equal(selfIntro?.commitParent, false);
  assert.equal(projectIntro?.kind, "project-intro");
  assert.equal(projectIntro?.projectAnchor, "Agentic Memory");
  assert.equal(projectIntro?.topicDomain, "ai-ml-infra");
  assert.equal(projectIntro?.commitParent, false);
  assert.equal(selectedProject?.kind, "project-intro");
  assert.equal(selectedProject?.commitParent, false);

  assert.equal(
    canOpeningRouteOwnCanonicalProjectParent({
      route: projectIntro,
      hasActiveParent: false,
      concreteQuestionType: "ai-ml-system-design",
    }),
    false
  );
  assert.equal(
    canOpeningRouteOwnCanonicalProjectParent({
      route: projectIntro,
      hasActiveParent: false,
    }),
    true
  );
  assert.equal(
    canOpeningRouteOwnCanonicalProjectParent({
      route: projectIntro,
      hasActiveParent: true,
    }),
    false
  );
  assert.equal(
    canOpeningRouteOwnCanonicalProjectParent({
      route: projectIntro,
      hasActiveParent: true,
      explicitTaskBoundary: true,
    }),
    true
  );
  assert.equal(
    canOpeningRouteOwnCanonicalProjectParent({
      route: selectedProject,
      hasActiveParent: false,
    }),
    false
  );
});

test("does not treat generic technical follow-ups as authoritative project introductions", () => {
  for (const text of [
    "Explain this system.",
    "Why did you choose Redis?",
    "How did you implement the queue?",
  ]) {
    assert.equal(detectOpeningTaskRoute(text), undefined, text);
  }

  const ambiguousNamedSystem = detectOpeningTaskRoute(
    "Explain the semantic search system."
  );
  assert.equal(ambiguousNamedSystem?.kind, "project-intro");
  assert.equal(ambiguousNamedSystem?.commitParent, false);
  assert.equal(
    canOpeningRouteOwnCanonicalProjectParent({
      route: ambiguousNamedSystem,
      hasActiveParent: false,
    }),
    false
  );
});

test("does not turn recruiter logistics, quoted examples, or future topics into openings", () => {
  for (const text of [
    "Do you now or in the future require sponsorship?",
    "Tell me about your salary expectations.",
    "We will discuss your background later in the interview.",
    "You can ask the team what projects they have worked on.",
    "I can tell you about the work that I've done at AWS.",
  ]) {
    assert.equal(detectOpeningTaskRoute(text), undefined, text);
  }
});
