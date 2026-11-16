import { UpdateChannel } from "../domain/types";
import { RELEASES_URL, UPDATE_CHECK_INTERVAL_MS } from "../shared/constants";
import type { UpdaterConfig } from "../shared/updates";

export interface GenericFeed {
  readonly provider: "generic";
  readonly url: string;
}

export interface UpdateInfoLike {
  readonly version: string;
}

export interface UpdateCheckerLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  forceDevUpdateConfig: boolean;
  setFeedURL(options: GenericFeed): void;
  checkForUpdates(): Promise<unknown>;
  on(
    event: "update-available",
    listener: (info: UpdateInfoLike) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

type TimerHandle = ReturnType<typeof setInterval>;

export interface UpdateNotifierDeps {
  readonly updater: UpdateCheckerLike;
  readonly isPackaged: boolean;
  readonly testFeedUrl: string | undefined;
  readonly setInterval: (run: () => void, ms: number) => TimerHandle;
  readonly clearInterval: (handle: TimerHandle) => void;
  readonly onChanged: (version: string | null) => void;
  readonly log: (message: string, error?: unknown) => void;
}

export interface UpdateNotifier {
  configure(config: UpdaterConfig): void;
  available(): string | null;
  dispose(): void;
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const PRERELEASE_SEPARATOR = "-";

const CHECK_FAILED_MESSAGE = "update check failed";
const INVALID_VERSION_MESSAGE = "ignored an update with an invalid version";

function isPrerelease(version: string): boolean {
  return version.includes(PRERELEASE_SEPARATOR);
}

function ignoreUpdaterError(): void {
  return undefined;
}

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

export async function openAvailableRelease(
  notifier: Pick<UpdateNotifier, "available">,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  const version = notifier.available();
  if (version !== null) {
    await openExternal(releaseUrl(version));
  }
}

function prepareUpdater(
  updater: UpdateCheckerLike,
  isPackaged: boolean,
  testFeedUrl: string | undefined,
): boolean {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.on("error", ignoreUpdaterError);
  if (isPackaged) {
    return true;
  }
  if (testFeedUrl === undefined) {
    return false;
  }
  updater.forceDevUpdateConfig = true;
  updater.setFeedURL({ provider: "generic", url: testFeedUrl });
  return true;
}

function createChecker(
  updater: UpdateCheckerLike,
  log: UpdateNotifierDeps["log"],
): () => Promise<void> {
  return async () => {
    try {
      await updater.checkForUpdates();
    } catch (error) {
      log(CHECK_FAILED_MESSAGE, error);
    }
  };
}

export function createUpdateNotifier({
  updater,
  isPackaged,
  testFeedUrl,
  setInterval: startTimer,
  clearInterval: stopTimer,
  onChanged,
  log,
}: UpdateNotifierDeps): UpdateNotifier {
  const active = prepareUpdater(updater, isPackaged, testFeedUrl);
  const check = createChecker(updater, log);
  let config: UpdaterConfig | null = null;
  let enabled = false;
  let timer: TimerHandle | null = null;
  let version: string | null = null;
  let running = false;
  let followUpPending = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      stopTimer(timer);
      timer = null;
    }
  };

  const runCheck = (): void => {
    running = true;
    void check().then(() => {
      running = false;
      const followUp = followUpPending && enabled;
      followUpPending = false;
      if (followUp) {
        runCheck();
      }
    });
  };

  const requestCheck = (): void => {
    if (running) {
      followUpPending = true;
    } else {
      runCheck();
    }
  };

  const dropPrereleaseVersion = (): void => {
    if (version !== null && isPrerelease(version)) {
      version = null;
      onChanged(null);
    }
  };

  updater.on("update-available", (info) => {
    if (!enabled || info.version === version) {
      return;
    }
    if (isPrerelease(info.version) && !updater.allowPrerelease) {
      return;
    }
    if (!SEMVER_PATTERN.test(info.version)) {
      log(INVALID_VERSION_MESSAGE);
      return;
    }
    version = info.version;
    onChanged(info.version);
  });

  return {
    configure(next) {
      if (
        !active ||
        (config?.enabled === next.enabled && config.channel === next.channel)
      ) {
        return;
      }
      config = next;
      enabled = next.enabled;
      updater.allowPrerelease = next.channel === UpdateChannel.beta;
      if (!updater.allowPrerelease) {
        dropPrereleaseVersion();
      }
      clearTimer();
      if (enabled) {
        requestCheck();
        timer = startTimer(() => {
          if (!running) {
            runCheck();
          }
        }, UPDATE_CHECK_INTERVAL_MS);
      }
    },
    available: () => version,
    dispose() {
      clearTimer();
      enabled = false;
      config = null;
    },
  };
}
