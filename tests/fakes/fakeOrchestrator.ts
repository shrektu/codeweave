import type { OrchestratorService } from "../../src/backend/orchestrator/service";

export function fakeOrchestrator(): OrchestratorService {
  return {
    start: () => Promise.reject(new Error("orchestrate is not faked")),
    shutdown: () => Promise.resolve(),
  };
}
