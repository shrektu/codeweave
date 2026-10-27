export interface CodeweaveApi {
  gpuAccelerated: boolean;
  pickFolder: () => Promise<string | null>;
}

declare global {
  interface Window {
    codeweave: CodeweaveApi;
  }
}
