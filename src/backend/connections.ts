import { PROTOCOL_VERSION } from "../shared/constants";
import type { PortLike } from "../shared/port";
import type { EventName, EventPayloadMap, IpcEvent } from "../shared/protocol";

import { createIpcServer, type IpcHandlers, type IpcServer } from "./ipcServer";

export interface ConnectionRegistry {
  connect(port: PortLike): void;
  size(): number;
  broadcast<E extends EventName>(event: E, payload: EventPayloadMap[E]): void;
}

export function createConnectionRegistry(
  handlers: IpcHandlers,
  onDisconnect: () => void = () => undefined,
): ConnectionRegistry {
  const live = new Set<IpcServer>();
  return {
    connect(port: PortLike): void {
      const server = createIpcServer(port, handlers);
      live.add(server);
      port.onClose(() => {
        live.delete(server);
        if (live.size === 0) {
          onDisconnect();
        }
      });
    },
    size(): number {
      return live.size;
    },
    broadcast<E extends EventName>(
      event: E,
      payload: EventPayloadMap[E],
    ): void {
      const message = { v: PROTOCOL_VERSION, event, payload } as IpcEvent;
      for (const server of live) {
        server.push(message);
      }
    },
  };
}
