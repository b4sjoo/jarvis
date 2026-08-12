import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildTauriArgs } from "./lib/moss-dev-port.mjs";

const tauriCliPath = fileURLToPath(
  new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url)
);

let tauriArgs;
try {
  tauriArgs = buildTauriArgs(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

if (tauriArgs) {
  const child = spawn(process.execPath, [tauriCliPath, ...tauriArgs], {
    env: process.env,
    stdio: "inherit",
  });

  child.once("error", (error) => {
    console.error(`Failed to launch the Tauri CLI: ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
