import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const APP_NAME = "Jarvis Native Diagnostics Test";
export const APP_ID = "dev.seasonsg.jarvis.native-diagnostics-test";
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const workspace = path.join(root, "src-tauri/target/native-smoke");
export const publishedApp = path.join(root, `src-tauri/target/debug/bundle/macos/${APP_NAME}.app`);

export function createBuildConfig(base, frontend, buildId) {
  return {
    productName: APP_NAME,
    identifier: APP_ID,
    build: { beforeBuildCommand: "", frontendDist: frontend },
    app: {
      windows: base.app.windows.map(window => ({
        ...window, title: `${APP_NAME} [${buildId}]`,
      })),
    },
  };
}

export function assertBuildIdentity(manifest, identifier, executableHash) {
  if (manifest.status !== "built" || identifier !== APP_ID || executableHash !== manifest.executableSha256) {
    throw new Error("Smoke bundle identity does not match this completed build");
  }
}

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function treeFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? treeFiles(file) : [file];
    });
}

export function parseJarvisProcesses(output) {
  return output.split("\n")
    .flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match && /(?:^|\/)jarvis$/.test(match[2]) ? [{pid:Number(match[1]), executable:match[2]}] : [];
    });
}

export function jarvisProcesses() {
  return parseJarvisProcesses(execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8" }));
}

export function bundleProcessIds(appPath = publishedApp) {
  const executable = path.join(appPath, "Contents/MacOS/jarvis");
  return jarvisProcesses().filter(process => process.executable === executable).map(process => process.pid);
}

async function command(executable, args, env, output) {
  const log = fs.openSync(output, "w");
  try {
    const child = spawn(executable, args, { cwd: root, env, stdio: ["ignore", log, log] });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ?? code));
    });
    if (exitCode !== 0) throw new Error(`${path.basename(executable)} failed (${exitCode}); see ${output}`);
  } finally { fs.closeSync(log); }
}

export async function buildSmoke() {
  if (process.platform !== "darwin") throw new Error("Initial native smoke supports macOS only");
  const running = bundleProcessIds();
  if (running.length) throw new Error(`Exit the existing smoke app first (PID ${running.join(",")})`);
  const id = `smoke-${Date.now()}`;
  const evidence = path.join(root, "evidence/native-app-smoke", id);
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const frontend = path.join(workspace, "frontend");
  const cargo = path.join(workspace, "cargo");
  const config = createBuildConfig(JSON.parse(fs.readFileSync(path.join(root,"src-tauri/tauri.conf.json"))), frontend, id);
  const configPath = path.join(evidence,"tauri.smoke.json");
  fs.writeFileSync(configPath, JSON.stringify(config,null,2));
  const files = git(["ls-files", "-co", "--exclude-standard", "src", "src-tauri", "scripts", "tests/native-smoke", "vite.config.ts", "package.json", "package-lock.json"])
    .split("\n").filter(Boolean);
  const inputs = [...new Set(files)].sort().map(file => ({file,sha256:hash(fs.readFileSync(path.join(root,file)))}));
  const manifest = {
    id, status:"building", gitCommit:git(["rev-parse","HEAD"]), gitDirty:Boolean(git(["status","--porcelain"])),
    sourceInputs:inputs, config, frontend, cargo, appPath:publishedApp, startedAt:new Date().toISOString(),
  };
  const manifestPath = path.join(evidence,"build.json");
  const save=()=>fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n");
  save();
  // Point at this attempt before building so a failed attempt cannot reuse an old success.
  fs.writeFileSync(path.join(workspace,"current.json"),JSON.stringify({manifestPath},null,2));
  fs.writeFileSync(path.join(evidence,"working-tree.patch"),execFileSync("git",["diff","--binary","HEAD"],{cwd:root}));
  const env={...process.env,CARGO_TARGET_DIR:cargo,CARGO_NET_OFFLINE:"true",
    JARVIS_NATIVE_SMOKE_BUILD_ID:id,JARVIS_NATIVE_SMOKE_FRONTEND:frontend};
  console.log(JSON.stringify({id,evidence,status:"building"}));
  try {
    await command(process.execPath,["node_modules/typescript/bin/tsc"],env,path.join(evidence,"typescript.log"));
    await command(process.execPath,["node_modules/vite/bin/vite.js","build","--config","tests/native-smoke/vite.config.ts","--outDir",frontend,"--emptyOutDir"],env,path.join(evidence,"frontend.log"));
    await command(process.execPath,["node_modules/@tauri-apps/cli/tauri.js","build","--debug","--features","native-app-smoke","--bundles","app","--config",configPath,"--ci"],env,path.join(evidence,"native.log"));
    const built=path.join(cargo,`debug/bundle/macos/${APP_NAME}.app`);
    const plist=JSON.parse(execFileSync("plutil",["-convert","json","-o","-",path.join(built,"Contents/Info.plist")],{encoding:"utf8"}));
    if(plist.CFBundleIdentifier!==APP_ID) throw new Error("Refuse to publish a non-smoke bundle");
    if(bundleProcessIds().length) throw new Error("Smoke app started during build; no replacement performed");
    manifest.executableSha256=hash(fs.readFileSync(path.join(built,"Contents/MacOS/jarvis")));
    manifest.frontendFiles=treeFiles(frontend).map(file=>({file:path.relative(frontend,file),sha256:hash(fs.readFileSync(file))}));
    if(fs.existsSync(publishedApp)) {
      manifest.previousExecutableSha256=hash(fs.readFileSync(path.join(publishedApp,"Contents/MacOS/jarvis")));
    }
    fs.mkdirSync(path.dirname(publishedApp),{recursive:true});
    const staged = `${publishedApp}.next`;
    const previous = `${publishedApp}.previous`;
    fs.rmSync(staged,{recursive:true,force:true});
    fs.renameSync(built,staged);
    // One replaceable test bundle, not an accumulating archive of runnable apps.
    fs.rmSync(previous,{recursive:true,force:true});
    if(fs.existsSync(publishedApp)) fs.renameSync(publishedApp,previous);
    try { fs.renameSync(staged,publishedApp); }
    catch(error) {
      if(fs.existsSync(previous)) fs.renameSync(previous,publishedApp);
      throw error;
    }
    fs.rmSync(previous,{recursive:true,force:true});
    manifest.status="built";
    manifest.endedAt=new Date().toISOString();
    save();
    console.log(JSON.stringify({id,status:manifest.status,appPath:publishedApp,manifestPath}));
    return manifest;
  } catch(error) {
    manifest.status="failed";manifest.error=String(error);manifest.endedAt=new Date().toISOString();save();throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildSmoke().catch(error=>{console.error(error.message);process.exitCode=1;});
}
