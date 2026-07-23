import assert from "node:assert/strict";
import test from "node:test";
import { detectOpeningTaskRoute } from "../src/lib/meeting/opening-route.js";

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

test("keeps self introduction transient and concrete project introductions durable", () => {
  const selfIntro = detectOpeningTaskRoute(
    "Before we begin, could you briefly introduce yourself?"
  );
  const projectIntro = detectOpeningTaskRoute(
    "Tell me about the Agentic Memory project and its hardest technical challenge."
  );
  const selectedProject = detectOpeningTaskRoute(
    "Tell me about a project you are proud of."
  );

  assert.equal(selfIntro?.kind, "self-intro");
  assert.equal(selfIntro?.commitParent, false);
  assert.equal(projectIntro?.kind, "project-intro");
  assert.equal(projectIntro?.projectAnchor, "Agentic Memory");
  assert.equal(projectIntro?.topicDomain, "ai-ml-infra");
  assert.equal(projectIntro?.commitParent, true);
  assert.equal(selectedProject?.kind, "project-intro");
  assert.equal(selectedProject?.commitParent, true);
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
