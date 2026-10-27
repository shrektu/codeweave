import type { MessagePort as NodeMessagePort } from "node:worker_threads";

import type { MessagePortMain } from "electron";

export interface PortLike {
  post(data: unknown): void;
  onMessage(listener: (data: unknown) => void): () => void;
  onClose(listener: () => void): void;
  close(): void;
}

export function fromNodePort(port: NodeMessagePort): PortLike {
  return {
    post(data: unknown): void {
      port.postMessage(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      port.on("message", listener);
      return (): void => {
        port.off("message", listener);
      };
    },
    onClose(listener: () => void): void {
      port.once("close", listener);
    },
    close(): void {
      port.close();
    },
  };
}

export function fromMainPort(port: MessagePortMain): PortLike {
  return {
    post(data: unknown): void {
      port.postMessage(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      const handler = (event: { data: unknown }): void => {
        listener(event.data);
      };
      port.on("message", handler);
      port.start();
      return (): void => {
        port.off("message", handler);
      };
    },
    onClose(listener: () => void): void {
      port.once("close", listener);
    },
    close(): void {
      port.close();
    },
  };
}
