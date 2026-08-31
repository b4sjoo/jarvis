import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const trackedEngineeringDocs = [
  "README.md",
  "architecture/README.md",
  "architecture/deletion-ledger.schema.json",
  "architecture/deletion-ledger.json",
  "architecture/architecture-contract.json",
  "architecture/orchestration-replay-baseline.json",
  "architecture/verification-budget.json",
];

test("architecture documentation has one canonical tracked entry point", () => {
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "ARCHITECTURE.md")),
    false,
    "root ARCHITECTURE.md must not duplicate architecture/README.md"
  );
});

test("clean-checkout engineering documents are present and tracked", () => {
  for (const relativePath of trackedEngineeringDocs) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, relativePath)), true, relativePath);
  }
  if (!fs.existsSync(path.join(repositoryRoot, ".git"))) return;
  const tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: repositoryRoot, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
  );
  for (const relativePath of trackedEngineeringDocs) {
    assert.equal(tracked.has(relativePath), true, `${relativePath} is not tracked`);
  }
});

test("tracked architecture documents contain no private runtime artifacts", () => {
  const forbidden = [
    /\/Users\//,
    /session-20\d{2}-\d{2}-\d{2}T/,
    /(?:api[_-]?key|authorization)\s*[:=]\s*["'][^"']+/i,
    /BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/,
  ];
  for (const relativePath of trackedEngineeringDocs) {
    if (!fs.existsSync(path.join(repositoryRoot, relativePath))) continue;
    const content = fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(content), false, `${relativePath} matched ${pattern}`);
    }
  }
});

test("README and tracked architecture markdown links resolve without private docs", () => {
  for (const relativePath of ["README.md", "architecture/README.md"]) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      assert.equal(
        target.startsWith("docs/"),
        false,
        `${relativePath} links to private docs`
      );
      assert.equal(
        fs.existsSync(path.resolve(path.dirname(absolutePath), target)),
        true,
        `${relativePath} has missing link ${target}`
      );
    }
  }
});

test("private working docs and generated architecture reports stay ignored", () => {
  const ignore = fs.readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");
  assert.match(ignore, /^docs\/$/m);
  assert.match(ignore, /^\.tmp-architecture\/$/m);
});
