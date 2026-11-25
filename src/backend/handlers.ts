import { SWITCH_LOG_SNAPSHOT_LIMIT } from "../shared/constants";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import { createAccountsService, type AccountsService } from "./accountsService";
import type { ConnectionRegistry } from "./connections";
import { createAgent, deleteAgent, saveAgent } from "./agents";
import { createDefinitionRoots } from "./definitionLibrary";
import type { EditedFilesTracker } from "./editedFiles";
import { listFlows, saveFlow } from "./flows";
import type { FlowRunService } from "./flowRuns";
import type { IpcHandlers } from "./ipcServer";
import type { LimitProbeService } from "./limitProbe";
import type { ModelCatalogService } from "./opencode/catalog";
import type { OrchestratorService } from "./orchestrator/service";
import type { KeyStore } from "./secrets/keyStore";
import type { SecretVault } from "./secrets/vault";
import type { ContainerStatus, SessionService } from "./session";
import type { SessionPool } from "./sessionPool";
import {
  createSettingsService,
  type PostUpdaterConfig,
} from "./settingsService";
import type { JsonStore } from "./storage";
import type { TerminalService } from "./terminal/service";

export interface HandlerDeps {
  store: JsonStore;
  keyStore: KeyStore;
  vault: SecretVault;
  userData: string;
  homeDir: string;
  broadcast: ConnectionRegistry["broadcast"];
  sessions: SessionPool;
  flowRuns: FlowRunService;
  orchestrator: OrchestratorService;
  probes: LimitProbeService;
  catalog: ModelCatalogService;
  containerStatus: ContainerStatus;
  terminals: TerminalService;
  postUpdaterConfig: PostUpdaterConfig;
  editedFiles: EditedFilesTracker;
}

const FLOW_RUNNING_MESSAGE = "A flow is running";
const SESSION_NOT_FOUND_MESSAGE = "Session not found";

function requireMain(sessions: SessionPool, sessionId: string): SessionService {
  const service = sessions.main(sessionId);
  if (service === null) {
    throw new IpcError(IpcErrorCode.NOT_FOUND, SESSION_NOT_FOUND_MESSAGE);
  }
  return service;
}

function publishAccounts(accounts: AccountsService): void {
  accounts.publish().catch((error: unknown) => {
    console.error("failed to publish accounts", error);
  });
}

export function createHandlers({
  store,
  keyStore,
  vault,
  userData,
  homeDir,
  broadcast,
  sessions,
  flowRuns,
  orchestrator,
  probes,
  catalog,
  containerStatus,
  terminals,
  postUpdaterConfig,
  editedFiles,
}: HandlerDeps): IpcHandlers {
  const accounts = createAccountsService({
    store,
    keyStore,
    userData,
    broadcast,
    runtimeOf: (id) => sessions.runtimeOf(id),
    limitOf: (id) => probes.limitOf(id),
    availabilityOf: (account) => probes.availabilityOf(account),
    isInUse: (id) => sessions.isInUse(id),
  });
  sessions.onRuntimeChanged(() => {
    publishAccounts(accounts);
  });
  probes.onChanged(() => {
    publishAccounts(accounts);
  });
  const synced = async <T>(mutation: Promise<T>): Promise<T> => {
    const result = await mutation;
    sessions.setAccounts(await store.readAccounts());
    return result;
  };
  const probed = async <T>(mutation: Promise<T>): Promise<T> => {
    const result = await synced(mutation);
    probes.trigger();
    return result;
  };
  const settings = createSettingsService({
    store,
    broadcast,
    postUpdaterConfig,
    homeDir,
  });
  const recorded = async <T>(folder: string, use: Promise<T>): Promise<T> => {
    const result = await use;
    await settings.recordFolder(folder).catch((error: unknown) => {
      console.error("recording recent folder failed", error);
    });
    return result;
  };
  const definitionRoots = createDefinitionRoots({ store, userData });
  return {
    ping: () => ({ pong: true, backendPid: process.pid }),
    "sessions/snapshot": async () => ({
      sessions: [...sessions.mainViews()],
      accounts: (await accounts.list()).accounts,
      settings: await settings.get(),
      switchLog: await store.readSwitchLog(SWITCH_LOG_SNAPSHOT_LIMIT),
      container: { ...containerStatus },
      terminal: terminals.view(),
      flowRuns: flowRuns.views(),
      flowSessions: [...sessions.runViews()],
      editedFiles: [...editedFiles.views()],
    }),
    "session/start": async (params) => {
      if (flowRuns.hasOpenUserRuns()) {
        throw new IpcError(IpcErrorCode.CONFLICT, FLOW_RUNNING_MESSAGE);
      }
      const startPlain = async (): Promise<
        Awaited<ReturnType<SessionService["start"]>>
      > => {
        const settling = sessions.settleEnded();
        if (settling !== null) {
          await settling;
        }
        const service = sessions.createMain();
        try {
          return await service.start(params);
        } catch (error) {
          await sessions.discardMain(service);
          throw error;
        }
      };
      const started =
        params.orchestrate === true ? orchestrator.start(params) : startPlain();
      const view = await (params.cwd === undefined
        ? started
        : recorded(params.cwd, started));
      await terminals.retarget(view.cwd).catch((error: unknown) => {
        console.error("terminal retarget failed", error);
      });
      return view;
    },
    "session/prompt": async ({ sessionId, text, ...overrides }) => {
      await requireMain(sessions, sessionId).prompt(text, overrides);
      return { accepted: true };
    },
    "session/stop": async ({ sessionId }) => {
      const service = requireMain(sessions, sessionId);
      const live = service.isLive();
      const phase = service.view()?.phase.phase;
      await service.stop();
      return {
        stopped: live || (phase !== undefined && phase !== "stopped"),
      };
    },
    "session/close": async ({ sessionId }) => {
      await sessions.closeMain(sessionId);
      return { closed: true };
    },
    "permission/answer": ({ requestId, optionId, sessionId, runId }) => {
      if (runId !== undefined) {
        flowRuns.answerPermission(runId, requestId, optionId);
      } else if (sessionId !== undefined) {
        requireMain(sessions, sessionId).answerPermission(requestId, optionId);
      }
      return { ok: true };
    },
    "accounts/list": () => accounts.list(),
    "accounts/suggest": () => accounts.suggest(),
    "accounts/add": (params) => probed(accounts.add(params)),
    "accounts/setKey": (params) => accounts.setKey(params),
    "vault/status": () => vault.status(),
    "models/catalog": () => catalog.load(),
    "accounts/remove": ({ id }) => probed(accounts.remove(id)),
    "accounts/move": ({ id, direction }) =>
      synced(accounts.move(id, direction)),
    "settings/get": () => settings.get(),
    "settings/set": (patch) => settings.set(patch),
    "switchLog/list": async () => ({
      entries: await store.readSwitchLog(SWITCH_LOG_SNAPSHOT_LIMIT),
    }),
    "flows/list": async ({ cwd }) => {
      const result = listFlows(await definitionRoots(cwd));
      return cwd === undefined ? result : recorded(cwd, result);
    },
    "flows/save": async ({ cwd, ...params }) =>
      saveFlow(await definitionRoots(cwd), params),
    "agents/create": async ({ cwd, ...params }) =>
      createAgent(await definitionRoots(cwd), params),
    "agents/save": async ({ cwd, ...params }) =>
      saveAgent(await definitionRoots(cwd), params),
    "agents/delete": async ({ cwd, ...params }) =>
      deleteAgent(await definitionRoots(cwd), params),
    "flow/start": (params) => flowRuns.start(params),
    "flow/stop": async ({ runId }) => {
      const stopped = flowRuns.isOpen(runId);
      await flowRuns.stop(runId);
      return { stopped };
    },
    "flow/decide": (params) => flowRuns.decide(params),
    "terminal/open": (params) => recorded(params.cwd, terminals.open(params)),
    "terminal/input": ({ id, data }) => {
      terminals.input(id, data);
      return { ok: true };
    },
    "terminal/resize": ({ id, cols, rows }) => {
      terminals.resize(id, cols, rows);
      return { ok: true };
    },
    "terminal/ack": ({ id, chars }) => {
      terminals.ack(id, chars);
      return { ok: true };
    },
    "terminal/detach": ({ id }) => {
      terminals.detach(id);
      return { ok: true };
    },
    "terminal/close": ({ id }) => terminals.close(id),
  };
}
