import path from "node:path";
import process from "node:process";
import { buildLocalIntentCorpusReadiness } from "./lib/local-intent-corpus-readiness.js";

interface CliOptions {
  recordingsRoot: string;
  sttCapturesRoot: string;
  overlaysPath: string;
  outputRoot: string;
  seed: string;
  cutoff: string;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await buildLocalIntentCorpusReadiness(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        buildId: result.buildId,
        sourceCount: result.sourceCount,
        exampleCount: result.exampleCount,
        reviewItemCount: result.reviewItemCount,
        corpusInfrastructure: result.qualityReport.goNoGo.corpusInfrastructure,
        questionTypeFrozenHead:
          result.qualityReport.goNoGo.questionTypeFrozenHead,
        threeHeadTraining: result.qualityReport.goNoGo.threeHeadTraining,
        restrictedEnforcement:
          result.qualityReport.goNoGo.restrictedEnforcement,
      },
      null,
      2
    )}\n`
  );
}

function parseOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) continue;
    values.set(key.slice(2), value);
    index += 1;
  }
  const required = [
    "recordings",
    "stt-captures",
    "overlays",
    "output",
    "seed",
    "cutoff",
  ];
  const missing = required.filter((key) => !values.get(key)?.trim());
  if (missing.length) {
    throw new Error(
      `Missing --${missing.join(", --")}. Usage: npm run intent:corpus:readiness -- --recordings <root> --stt-captures <root> --overlays <json-or-directory> --output <private-output> --seed <id> --cutoff <ISO-8601>`
    );
  }
  return {
    recordingsRoot: path.resolve(values.get("recordings") as string),
    sttCapturesRoot: path.resolve(values.get("stt-captures") as string),
    overlaysPath: path.resolve(values.get("overlays") as string),
    outputRoot: path.resolve(values.get("output") as string),
    seed: values.get("seed") as string,
    cutoff: values.get("cutoff") as string,
  };
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
