import type { PortLike } from "../shared/port";
import { createIpcServer, type IpcHandlers, type IpcServer } from "./ipcServer";

export interface ConnectionRegistry {
  connect(port: PortLike): void;
  size(): number;
}

export function createConnectionRegistry(
  handlers: IpcHandlers,
): ConnectionRegistry {
  const live = new Set<IpcServer>();
  return {
    connect(port: PortLike): void {
      const server = createIpcServer(port, handlers);
      live.add(server);
      port.onClose(() => {
        live.delete(server);
      });
    },
    size(): number {
      return live.size;
    },
  };
}
