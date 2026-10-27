export interface CodeweaveApi {
  gpuAccelerated: boolean;
}

declare global {
  interface Window {
    codeweave: CodeweaveApi;
  }
}
