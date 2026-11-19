import { ProviderId } from "../domain/types";

export const PROTOCOL_VERSION = 6;

export const EXECUTABLE_SETTING_LABELS: Readonly<Record<ProviderId, string>> = {
  [ProviderId.claude]: "Claude executable",
  [ProviderId.codex]: "Codex executable",
  [ProviderId.opencode]: "OpenCode executable",
  [ProviderId.gemini]: "Gemini executable (agy)",
};

export const OPENCODE_ACCOUNT_DATA_DIR = "data";

export const OPENCODE_DATA_SUBDIR = "opencode";

export const OPENCODE_DB_FILE_NAME = "opencode.db";

export const TERMINAL_MIN_COLS = 2;

export const TERMINAL_MAX_COLS = 1000;

export const TERMINAL_MIN_ROWS = 1;

export const TERMINAL_MAX_ROWS = 500;

export const TERMINAL_INPUT_MAX_CHARS = 65_536;

export const PORT_CHANNEL = "codeweave:port";

export const CONNECT_MESSAGE_TYPE = "connect";

export const SHUTDOWN_MESSAGE_TYPE = "shutdown";

export const SHUTDOWN_DONE_MESSAGE_TYPE = "shutdown-done";

export const VAULT_REQUEST_MESSAGE_TYPE = "vault/request";

export const VAULT_RESPONSE_MESSAGE_TYPE = "vault/response";

export const VAULT_REQUEST_TIMEOUT_MS = 5000;

export const UPDATER_CONFIG_MESSAGE_TYPE = "updater/config";

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const RELEASES_URL = "https://github.com/shrektu/codeweave/releases";

export const CATALOG_PROBE_TIMEOUT_MS = 45_000;

export const CATALOG_STOP_MARGIN_MS = 20_000;

export const USER_DATA_ARG = "--codeweave-user-data";

export const TEST_AGENT_ENV_ARG = "--codeweave-test-agent-env";

export const PICK_FOLDER_CHANNEL = "codeweave:pick-folder";

export const GET_AVAILABLE_UPDATE_CHANNEL = "codeweave:get-available-update";

export const OPEN_UPDATE_RELEASE_CHANNEL = "codeweave:open-update-release";

export const UPDATE_AVAILABLE_CHANNEL = "codeweave:update-available";

export const GET_GPU_ACCELERATED_CHANNEL = "codeweave:get-gpu-accelerated";

export const GPU_ACCELERATED_CHANNEL = "codeweave:gpu-accelerated";

export const SWITCH_LOG_SNAPSHOT_LIMIT = 50;

export const SNAPSHOT_RETRY_MS = 2000;
