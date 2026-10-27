import { createContext, use } from "react";

import type { IpcClient } from "./ipc";
import { useAppState, type AppState, type AppStore } from "./store";

export interface Services {
  client: IpcClient;
  store: AppStore;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = use(ServicesContext);
  if (services === null) {
    throw new Error("Missing ServicesContext provider");
  }
  return services;
}

export function useApp(): { client: IpcClient; state: AppState } {
  const { client, store } = useServices();
  return { client, state: useAppState(store) };
}
