export const DEFAULT_JARVIS_DEV_PORT: number;
export const MAX_JARVIS_DEV_PORT: number;

export type JarvisDevEnvironment = {
  JARVIS_DEV_PORT?: string;
};

export function hasJarvisDevPortOverride(
  environment?: JarvisDevEnvironment
): boolean;

export function resolveJarvisDevPort(
  environment?: JarvisDevEnvironment
): number;

export function buildTauriArgs(
  args: string[],
  environment?: JarvisDevEnvironment
): string[];
