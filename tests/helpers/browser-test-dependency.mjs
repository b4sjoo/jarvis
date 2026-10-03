import { lstatSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// The one dependency rule for the real-browser consumer tests (Task 202A).
//
// Ordinary run: neither variable is set. The default Playwright package is
// optional, so its genuine absence is an explicit skip. A package that is
// present but cannot be resolved or loaded is a failure.
//
// Explicit run: either variable is set. A real browser run is then required,
// so every problem below is a failure. Nothing falls back to another install.
const MODULE_VARIABLE = "JARVIS_PLAYWRIGHT_MODULE";
const EXECUTABLE_VARIABLE = "JARVIS_CHROMIUM_EXECUTABLE";
const DEFAULT_MODULE = "playwright";

// Relative module paths keep resolving from tests/, where the consumers live.
const requireFromTests = createRequire(new URL("../", import.meta.url));

export function loadBrowserTestDependency({ env = process.env, require = requireFromTests } = {}) {
  const configuredModule = env[MODULE_VARIABLE];
  const configuredExecutable = env[EXECUTABLE_VARIABLE];
  const required = configuredModule !== undefined || configuredExecutable !== undefined;
  const request = configuredModule ?? DEFAULT_MODULE;
  const source = configuredModule === undefined
    ? `the default "${DEFAULT_MODULE}" package`
    : `${MODULE_VARIABLE}=${JSON.stringify(configuredModule)}`;
  const consequence = required
    ? "a real browser run was explicitly requested, so this is a failure and not a skip"
    : "only a package that is not installed at all may skip";

  let entry;
  try {
    entry = require.resolve(request);
  } catch (error) {
    if (!required && isNotInstalled(error, request, require)) {
      return {
        playwright: undefined,
        skip: `Playwright is not installed and neither ${MODULE_VARIABLE} nor ` +
          `${EXECUTABLE_VARIABLE} is set; the real-browser test body was not executed`,
      };
    }
    throw new Error(`Browser test dependency: ${source} cannot be resolved; ${consequence}`, { cause: error });
  }

  let playwright;
  try {
    playwright = require(entry);
  } catch (error) {
    throw new Error(`Browser test dependency: ${source} resolved to ${entry} but failed to load; ${consequence}`, { cause: error });
  }
  if (typeof playwright?.chromium?.launch !== "function") {
    throw new Error(`Browser test dependency: ${source} resolved to ${entry} but does not export chromium.launch; ${consequence}`);
  }
  if (configuredExecutable !== undefined && !statSync(configuredExecutable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Browser test dependency: ${EXECUTABLE_VARIABLE}=${JSON.stringify(configuredExecutable)} ` +
      `is not an existing file; ${consequence}`);
  }
  return { playwright, skip: false };
}

// Node reports the same MODULE_NOT_FOUND for a package directory that exists
// without a loadable entry, so the search paths decide whether it is absent.
function isNotInstalled(error, request, require) {
  if (error?.code !== "MODULE_NOT_FOUND") return false;
  return (require.resolve.paths(request) ?? []).every(directory => {
    try {
      lstatSync(path.join(directory, request));
      return false;
    } catch (lookup) {
      if (lookup.code === "ENOENT" || lookup.code === "ENOTDIR") return true;
      throw lookup;
    }
  });
}
