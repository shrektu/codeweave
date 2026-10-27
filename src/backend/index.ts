import { fromMainPort } from "../shared/port";
import { ConnectMessageSchema } from "../shared/protocol";
import { createConnectionRegistry } from "./connections";
import type { IpcHandlers } from "./ipcServer";

const handlers: IpcHandlers = {
  ping: () => ({ pong: true, backendPid: process.pid }),
};
const connections = createConnectionRegistry(handlers);

process.parentPort.on("message", (event) => {
  const [port] = event.ports;
  if (
    port === undefined ||
    !ConnectMessageSchema.safeParse(event.data).success
  ) {
    return;
  }
  connections.connect(fromMainPort(port));
});
