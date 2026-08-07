import path from "node:path";
import process from "node:process";
import { buildLocalIntentAnnotationPilot } from "./lib/local-intent-annotation-pilot.js";

interface CliOptions {
  corpusRoot: string;
  outputRoot: string;
  seed: string;
  size: number;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await buildLocalIntentAnnotationPilot(options);
  process.stdout.write(
    `${JSON.stringify(
      {
        pilotId: result.manifest.pilotId,
        corpusBuildId: result.manifest.corpusBuildId,
        selectedCards: result.manifest.selectedCards,
        blinded: result.manifest.blinded,
        stratumCounts: result.manifest.stratumCounts,
        outputRoot: options.outputRoot,
      },
      null,
      2
    )}\n`
  );
}

function parseOptions(args: string[]): CliOptions {
  const values = parseFlagValues(args);
  const missing = ["corpus", "output", "seed"].filter(
    (key) => !values.get(key)?.trim()
  );
  if (missing.length) {
    throw new Error(
      `Missing --${missing.join(", --")}. Usage: npm run intent:corpus:pilot -- --corpus <readiness-output> --output <private-pilot-output> --seed <id> [--size 80]`
    );
  }
  const size = Number(values.get("size") ?? "80");
  if (!Number.isInteger(size) || size < 4) {
    throw new Error("--size must be an integer of at least four.");
  }
  return {
    corpusRoot: path.resolve(values.get("corpus") as string),
    outputRoot: path.resolve(values.get("output") as string),
    seed: values.get("seed") as string,
    size,
  };
}

function parseFlagValues(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) continue;
    values.set(key.slice(2), value);
    index += 1;
  }
  return values;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
