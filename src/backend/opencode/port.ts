import { createServer } from "node:net";

import { LOOPBACK_HOST } from "./constants";

const NO_PORT_MESSAGE = "Could not determine a free port";

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError !== undefined) {
          reject(closeError);
        } else if (address === null || typeof address === "string") {
          reject(new Error(NO_PORT_MESSAGE));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}
