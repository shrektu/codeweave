export const PROTOCOL_VERSION = 5;

export const PORT_CHANNEL = "codeweave:port";

export const CONNECT_MESSAGE_TYPE = "connect";

export const SHUTDOWN_MESSAGE_TYPE = "shutdown";

export const SHUTDOWN_DONE_MESSAGE_TYPE = "shutdown-done";

export const VAULT_REQUEST_MESSAGE_TYPE = "vault/request";

export const VAULT_RESPONSE_MESSAGE_TYPE = "vault/response";

export const VAULT_REQUEST_TIMEOUT_MS = 5000;

export const CATALOG_PROBE_TIMEOUT_MS = 45_000;

export const CATALOG_STOP_MARGIN_MS = 20_000;

export const GPU_ACCELERATED_ARG = "--codeweave-gpu-accelerated";

export const USER_DATA_ARG = "--codeweave-user-data";

export const TEST_AGENT_ENV_ARG = "--codeweave-test-agent-env";

export const PICK_FOLDER_CHANNEL = "codeweave:pick-folder";

export const SWITCH_LOG_SNAPSHOT_LIMIT = 50;

export const SNAPSHOT_RETRY_MS = 2000;
