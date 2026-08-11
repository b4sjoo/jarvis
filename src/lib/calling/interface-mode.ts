export type MossInterfaceMode = "control" | "companion";

export interface MossWindowProfile {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  alwaysOnTop: boolean;
}

export const MOSS_WINDOW_PROFILES: Record<
  MossInterfaceMode,
  MossWindowProfile
> = {
  control: {
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    alwaysOnTop: false,
  },
  companion: {
    width: 860,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    alwaysOnTop: true,
  },
};
