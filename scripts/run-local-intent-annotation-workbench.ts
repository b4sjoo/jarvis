import path from "node:path";
import process from "node:process";
import { startLocalIntentAnnotationWorkbench } from "./lib/local-intent-annotation-workbench.js";

interface CliOptions {
  pilotRoot: string;
  annotationRoot: string;
  annotator: string;
  port: number;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const workbench = await startLocalIntentAnnotationWorkbench(options);
  process.stdout.write(
    `Task 155 blinded annotation workbench\n${workbench.url}\n` +
      `Labels: ${options.annotationRoot}\n` +
      "Press Ctrl+C to stop.\n"
  );
  const stop = async () => {
    await workbench.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function parseOptions(args: string[]): CliOptions {
  const values = parseFlagValues(args);
  const missing = ["pilot", "annotations", "annotator"].filter(
    (key) => !values.get(key)?.trim()
  );
  if (missing.length) {
    throw new Error(
      `Missing --${missing.join(", --")}. Usage: npm run intent:corpus:annotate -- --pilot <pilot-output> --annotations <private-label-output> --annotator <id> [--port 0]`
    );
  }
  const port = Number(values.get("port") ?? "0");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer from 0 through 65535.");
  }
  return {
    pilotRoot: path.resolve(values.get("pilot") as string),
    annotationRoot: path.resolve(values.get("annotations") as string),
    annotator: values.get("annotator") as string,
    port,
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
