export const DEFAULT_MOSS_DEV_PORT = 1420;
export const MAX_MOSS_DEV_PORT = 65534;

export function hasMossDevPortOverride(environment = process.env) {
  return Boolean(environment.MOSS_DEV_PORT?.trim());
}

export function resolveMossDevPort(environment = process.env) {
  const rawPort = environment.MOSS_DEV_PORT?.trim();
  if (!rawPort) return DEFAULT_MOSS_DEV_PORT;

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(
      `Invalid MOSS_DEV_PORT "${rawPort}". Expected an integer from 1 to ${MAX_MOSS_DEV_PORT}.`
    );
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > MAX_MOSS_DEV_PORT) {
    throw new Error(
      `Invalid MOSS_DEV_PORT "${rawPort}". Expected an integer from 1 to ${MAX_MOSS_DEV_PORT}.`
    );
  }
  return port;
}

export function buildTauriArgs(args, environment = process.env) {
  const nextArgs = [...args];
  if (nextArgs[0] !== "dev" || !hasMossDevPortOverride(environment)) {
    return nextArgs;
  }

  const port = resolveMossDevPort(environment);
  const config = JSON.stringify({
    build: { devUrl: `http://localhost:${port}` },
  });
  const runnerArgsIndex = nextArgs.indexOf("--");
  const configIndex = runnerArgsIndex === -1 ? nextArgs.length : runnerArgsIndex;
  nextArgs.splice(configIndex, 0, "--config", config);
  return nextArgs;
}
