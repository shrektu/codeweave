import { SHUTDOWN_DONE_MESSAGE_TYPE } from "../shared/constants";
import { fromMainPort } from "../shared/port";
import {
  ConnectMessageSchema,
  ShutdownMessageSchema,
  type ShutdownDoneMessage,
} from "../shared/protocol";

import { parseBackendArgs } from "./args";
import { createConnectionRegistry } from "./connections";
import { createHandlers } from "./handlers";
import { createJsonStore } from "./storage";

const { userData } = parseBackendArgs(process.argv);
const store = createJsonStore(userData);

const handlers = createHandlers({
  store,
  userData,
  broadcast: (event, payload) => {
    connections.broadcast(event, payload);
  },
});
const connections = createConnectionRegistry(handlers);

function handleShutdown(): Promise<void> {
  return Promise.resolve();
}

process.parentPort.on("message", (event) => {
  if (ShutdownMessageSchema.safeParse(event.data).success) {
    void handleShutdown().then(() => {
      const done: ShutdownDoneMessage = { type: SHUTDOWN_DONE_MESSAGE_TYPE };
      process.parentPort.postMessage(done);
    });
    return;
  }
  const [port] = event.ports;
  if (
    port === undefined ||
    !ConnectMessageSchema.safeParse(event.data).success
  ) {
    return;
  }
  connections.connect(fromMainPort(port));
});
