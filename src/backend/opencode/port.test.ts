import { createServer } from "node:net";
import { describe, expect, it } from "vitest";

import { findFreePort } from "./port";

function listenOn(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve(
        () =>
          new Promise((done) => {
            server.close(() => {
              done();
            });
          }),
      );
    });
  });
}

describe("findFreePort", () => {
  it("returns_a_port_that_can_be_bound_right_after", async () => {
    const port = await findFreePort();

    const release = await listenOn(port);
    await release();

    expect(port).toBeGreaterThan(0);
  });
});
