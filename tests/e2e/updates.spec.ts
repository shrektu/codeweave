import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";

const ROOT_DIR = join(import.meta.dirname, "..", "..");
const USER_DATA_DIR_ENV = "CODEWEAVE_USER_DATA_DIR";
const TEST_FEED_ENV = "CODEWEAVE_TEST_UPDATE_FEED";
const USER_DATA_PREFIX = "codeweave-e2e-updates-";
const SETTINGS_FILE = "settings.json";
const FEED_FILE_PATTERN = /^\/latest.*\.yml$/;
const BANNER_TEXT = "Codeweave 99.0.0 is available.";
const QUIET_PERIOD_MS = 5000;
const SANDBOX_FLAGS =
  process.env.CI !== undefined && process.platform === "linux"
    ? ["--no-sandbox"]
    : [];
const SETTINGS_WITH_CHECK_OFF = JSON.stringify({
  version: 1,
  permissionProfile: "plan",
  effectLevel: "low",
  claudeExecutable: null,
  updateCheck: false,
  updateChannel: "stable",
});
const RELEASE_ARTIFACT = "Codeweave-99.0.0.bin";
const FEED_BODY = [
  "version: 99.0.0",
  "files:",
  `  - url: ${RELEASE_ARTIFACT}`,
  "    sha512: AAAA",
  "    size: 1",
  `path: ${RELEASE_ARTIFACT}`,
  "sha512: AAAA",
  "releaseDate: '2026-11-01T00:00:00.000Z'",
  "",
].join("\n");

interface Feed {
  readonly url: string;
  requests(): number;
  close(): Promise<void>;
}

async function startFeed(): Promise<Feed> {
  let count = 0;
  const server: Server = createServer((request, response) => {
    count += 1;
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (FEED_FILE_PATTERN.test(pathname)) {
      response.writeHead(200, { "content-type": "text/yaml" });
      response.end(FEED_BODY);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the feed server did not bind to a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port.toString()}`,
    requests: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function withApp(
  options: { feed: Feed; settings?: string },
  body: (app: ElectronApplication) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), USER_DATA_PREFIX));
  if (options.settings !== undefined) {
    await writeFile(join(userDataDir, SETTINGS_FILE), options.settings);
  }
  const app = await electron.launch({
    args: [".", ...SANDBOX_FLAGS],
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      [USER_DATA_DIR_ENV]: userDataDir,
      [TEST_FEED_ENV]: options.feed.url,
    },
  });
  try {
    await body(app);
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

test("update_banner_shows_the_version_announced_by_the_feed", async () => {
  const feed = await startFeed();
  try {
    await withApp({ feed }, async (app) => {
      const page = await app.firstWindow();

      await expect(page.getByText(BANNER_TEXT)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "View release" }),
      ).toBeVisible();
      expect(feed.requests()).toBeGreaterThan(0);
    });
  } finally {
    await feed.close();
  }
});

test("update_checks_off_make_no_request_and_show_no_banner", async () => {
  const feed = await startFeed();
  try {
    await withApp({ feed, settings: SETTINGS_WITH_CHECK_OFF }, async (app) => {
      const page = await app.firstWindow();
      await expect(page.getByRole("status", { name: "Backend" })).toHaveText(
        "Connected",
      );

      await delay(QUIET_PERIOD_MS);

      expect(feed.requests()).toBe(0);
      await expect(page.getByText(BANNER_TEXT)).toHaveCount(0);
    });
  } finally {
    await feed.close();
  }
});
