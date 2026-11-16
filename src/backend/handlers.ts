import { SWITCH_LOG_SNAPSHOT_LIMIT } from "../shared/constants";
import { IpcError, IpcErrorCode } from "../shared/protocol";

import { createAccountsService, type AccountsService } from "./accountsService";
import type { ConnectionRegistry } from "./connections";
import { listFlows, saveFlow } from "./flows";
import type { FlowRunService } from "./flowRuns";
import type { IpcHandlers } from "./ipcServer";
import type { LimitProbeService } from "./limitProbe";
import type { ModelCatalogService } from "./opencode/catalog";
import type { KeyStore } from "./secrets/keyStore";
import type { SecretVault } from "./secrets/vault";
import type { ContainerStatus, SessionService } from "./session";
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
  broadcast: ConnectionRegistry["broadcast"];
  sessions: SessionService;
  flowRuns: FlowRunService;
  probes: LimitProbeService;
  catalog: ModelCatalogService;
  containerStatus: ContainerStatus;
  terminals: TerminalService;
  postUpdaterConfig: PostUpdaterConfig;
}

const FLOW_RUNNING_MESSAGE = "A flow is running";

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
  broadcast,
  sessions,
  flowRuns,
  probes,
  catalog,
  containerStatus,
  terminals,
  postUpdaterConfig,
}: HandlerDeps): IpcHandlers {
  const accounts = createAccountsService({
    store,
    keyStore,
    userData,
    broadcast,
    runtimeOf: (id) => sessions.runtimeOf(id),
    limitOf: (id) => probes.limitOf(id),
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
  });
  return {
    ping: () => ({ pong: true, backendPid: process.pid }),
    "sessions/snapshot": async () => ({
      session: sessions.view(),
      accounts: (await accounts.list()).accounts,
      settings: await settings.get(),
      switchLog: await store.readSwitchLog(SWITCH_LOG_SNAPSHOT_LIMIT),
      container: { ...containerStatus },
      terminal: terminals.view(),
      flowRun: flowRuns.view(),
    }),
    "session/start": async (params) => {
      if (flowRuns.isActive()) {
        throw new IpcError(IpcErrorCode.CONFLICT, FLOW_RUNNING_MESSAGE);
      }
      const view = await sessions.start(params);
      await terminals.retarget(view.cwd).catch((error: unknown) => {
        console.error("terminal retarget failed", error);
      });
      return view;
    },
    "session/prompt": async ({ text }) => {
      await sessions.prompt(text);
      return { accepted: true };
    },
    "session/stop": async () => {
      if (flowRuns.isActive()) {
        await flowRuns.stop();
        return { stopped: true };
      }
      const phase = sessions.view()?.phase.phase;
      await sessions.stop();
      return { stopped: phase !== undefined && phase !== "stopped" };
    },
    "permission/answer": ({ requestId, optionId }) => {
      sessions.answerPermission(requestId, optionId);
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
    "flows/list": ({ cwd }) => listFlows(cwd),
    "flows/save": ({ cwd, ...params }) => saveFlow(cwd, params),
    "flow/start": (params) => flowRuns.start(params),
    "flow/stop": async () => {
      const stopped = flowRuns.isActive();
      await flowRuns.stop();
      return { stopped };
    },
    "flow/decide": (params) => flowRuns.decide(params),
    "terminal/open": (params) => terminals.open(params),
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
