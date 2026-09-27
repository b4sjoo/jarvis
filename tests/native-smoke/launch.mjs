import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertBuildIdentity, bundleProcessIds, jarvisProcesses, publishedApp, workspace } from "./build.mjs";

export function verifiedManifest(manifestPath) {
  const current = JSON.parse(fs.readFileSync(path.join(workspace, "current.json")));
  if (path.resolve(manifestPath) !== current.manifestPath) throw new Error("Only the latest build attempt may launch");
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (manifest.appPath !== publishedApp) throw new Error("Unexpected smoke bundle path");
  const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(publishedApp, "Contents/Info.plist")], { encoding: "utf8" }));
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(publishedApp,"Contents/MacOS/jarvis"))).digest("hex");
  assertBuildIdentity(manifest, plist.CFBundleIdentifier, hash);
  const helper = path.join(workspace, "keyboard-helper");
  if (manifest.keyboardHelper !== helper || crypto.createHash("sha256")
    .update(fs.readFileSync(helper)).digest("hex") !== manifest.keyboardHelperSha256) {
    throw new Error("Keyboard helper does not match the completed smoke build");
  }
  // Real app global shortcuts are unchanged, so concurrent instances are not isolated.
  if (jarvisProcesses().length) throw new Error("Exit other Jarvis instances before native smoke; no processes were changed");
  return manifest;
}

export async function launch(manifestPath) {
  const manifest = verifiedManifest(manifestPath);
  const directory = path.join(path.dirname(manifestPath), `run-${Date.now()}`);
  fs.mkdirSync(directory);
  const receipt = { buildId: manifest.id, appPath: manifest.appPath, directory, startedAt: new Date().toISOString(), status: "launching" };
  const save = () => fs.writeFileSync(path.join(directory, "lifecycle.json"), JSON.stringify(receipt, null, 2));
  save();
  console.log(JSON.stringify(receipt));
  const child = spawn("open", ["-n", "-W", "--stdout", path.join(directory,"stdout.log"), "--stderr", path.join(directory,"stderr.log"), manifest.appPath]);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  try {
    // PID discovery is bounded; the UI tool handles interaction and normal Quit.
    for (let attempt = 0; attempt < 60; attempt++) {
      const pids = bundleProcessIds();
      if (pids.length === 1) { receipt.pid = pids[0]; break; }
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    receipt.status = receipt.pid ? "running" : "launch-unconfirmed";
    save();
    console.log(JSON.stringify(receipt));
    if (!receipt.pid) {
      child.kill("SIGTERM"); // Only our `open -W` helper, never an unidentified app process.
      await exited;
      throw new Error("No uniquely owned test PID observed within 30 seconds");
    }
    const code = await exited;
    const remaining = bundleProcessIds();
    const log = fs.existsSync(path.join(directory,"stderr.log")) ? fs.readFileSync(path.join(directory,"stderr.log"),"utf8") : "";
    receipt.exitCode = code;
    receipt.remainingPids = remaining;
    receipt.status = code === 0 && receipt.pid && !remaining.length && log.includes("ApplicationShutdownReceipt ") ? "quit-confirmed" : "exit-unconfirmed";
  } catch(error) {
    receipt.status = "failed"; receipt.error = String(error);
    throw error;
  } finally {
    receipt.remainingPids = bundleProcessIds();
    receipt.endedAt = new Date().toISOString(); save(); console.log(JSON.stringify(receipt));
  }
  if (receipt.status !== "quit-confirmed") throw new Error("Normal Quit was not confirmed; see lifecycle evidence");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Pass the explicit successful build.json from this attempt");
  launch(path.resolve(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
}
