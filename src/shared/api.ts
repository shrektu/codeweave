import type { Appearance } from "../domain/types";

export interface AvailableUpdate {
  version: string;
}

export interface CodeweaveApi {
  isGpuAccelerated: () => boolean;
  onGpuAcceleratedChanged: (
    listener: (accelerated: boolean) => void,
  ) => () => void;
  pickFolder: () => Promise<string | null>;
  getAvailableUpdate: () => Promise<AvailableUpdate | null>;
  onUpdateAvailable: (
    listener: (update: AvailableUpdate | null) => void,
  ) => () => void;
  openUpdateRelease: () => Promise<void>;
  openLink: (url: string) => Promise<void>;
  platform: string;
  setThemeSource: (appearance: Appearance) => Promise<void>;
}

declare global {
  interface Window {
    codeweave: CodeweaveApi;
  }
}
