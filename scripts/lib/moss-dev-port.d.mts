export const DEFAULT_MOSS_DEV_PORT: number;
export const MAX_MOSS_DEV_PORT: number;
export function hasMossDevPortOverride(environment?: NodeJS.ProcessEnv): boolean;
export function resolveMossDevPort(environment?: NodeJS.ProcessEnv): number;
export function buildTauriArgs(args: string[], environment?: NodeJS.ProcessEnv): string[];
