import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MOSS_DEV_PORT,
  resolveMossDevPort,
} from "./scripts/lib/moss-dev-port.mjs";

const host = process.env.TAURI_DEV_HOST;
const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version?: string };

function readGitValue(args: string[], fallback = "unknown") {
  try {
    return execFileSync("git", args, {
      cwd: path.resolve(__dirname),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

const gitCommit = readGitValue(["rev-parse", "HEAD"]);
const gitDirty = Boolean(readGitValue(["status", "--porcelain"], ""));
const buildTimestamp = new Date().toISOString();

// https://vite.dev/config/
export default defineConfig(async ({ command }) => {
  const devPort =
    command === "serve"
      ? resolveMossDevPort(process.env)
      : DEFAULT_MOSS_DEV_PORT;

  return {
    plugins: [react()],
    define: {
      __MOSS_APP_VERSION__: JSON.stringify(packageJson.version ?? "unknown"),
      __MOSS_GIT_COMMIT__: JSON.stringify(gitCommit),
      __MOSS_GIT_DIRTY__: JSON.stringify(gitDirty),
      __MOSS_BUILD_TIMESTAMP__: JSON.stringify(buildTimestamp),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. Tauri and Vite share MOSS_DEV_PORT and fail when that exact port is unavailable
    server: {
      port: devPort,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: devPort + 1,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
