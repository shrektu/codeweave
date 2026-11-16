export interface AvailableUpdate {
  version: string;
}

export interface CodeweaveApi {
  gpuAccelerated: boolean;
  pickFolder: () => Promise<string | null>;
  getAvailableUpdate: () => Promise<AvailableUpdate | null>;
  onUpdateAvailable: (
    listener: (update: AvailableUpdate | null) => void,
  ) => () => void;
  openUpdateRelease: () => Promise<void>;
}

declare global {
  interface Window {
    codeweave: CodeweaveApi;
  }
}
