import { ProviderId } from "../domain/types";
import {
  OPENCODE_ACCOUNT_DATA_DIR,
  OPENCODE_DATA_SUBDIR,
  OPENCODE_DB_FILE_NAME,
} from "../shared/constants";

const BACKSLASH = "\\";
const SLASH = "/";
const TRAILING_SEPARATORS = /[\\/]+$/;
const CONSOLE_LOGIN_VARIABLE = "OPENCODE_DB";
const CONSOLE_LOGIN_COMMAND =
  "opencode auth login opencode --method device --standalone";
const CONSOLE_LOGIN_HINT =
  "Run this in a terminal, then confirm the code in the browser (needs opencode 2.2.5 or newer):";
const SINGLE_QUOTE = "'";
const BASH_ESCAPED_QUOTE = "'\\''";
const POWERSHELL_SINGLE_QUOTES = /['‘’‚‛]/g;

export interface LoginCommands {
  bash: string;
  powershell: string;
  hint: string;
}

interface LoginSpec {
  readonly variable: string | null;
  readonly command: string;
  readonly hint: string;
}

const LOGIN_SPECS: Readonly<Partial<Record<ProviderId, LoginSpec>>> = {
  [ProviderId.claude]: {
    variable: "CLAUDE_CONFIG_DIR",
    command: "claude",
    hint: "Run this in a terminal, then type /login:",
  },
  [ProviderId.codex]: {
    variable: "CODEX_HOME",
    command: "codex login",
    hint: "Run this in a terminal:",
  },
  [ProviderId.gemini]: {
    variable: null,
    command: "agy",
    hint: "Run this in a terminal, then sign in with Google:",
  },
};

function quoteBash(value: string): string {
  return value.replaceAll(SINGLE_QUOTE, BASH_ESCAPED_QUOTE);
}

function quotePowershell(value: string): string {
  return value.replace(POWERSHELL_SINGLE_QUOTES, (quote) => quote + quote);
}

function accountDbPath(configDir: string): string {
  const separator =
    configDir.includes(BACKSLASH) && !configDir.includes(SLASH)
      ? BACKSLASH
      : SLASH;
  return [
    configDir.replace(TRAILING_SEPARATORS, ""),
    OPENCODE_ACCOUNT_DATA_DIR,
    OPENCODE_DATA_SUBDIR,
    OPENCODE_DB_FILE_NAME,
  ].join(separator);
}

export function consoleLoginCommands(configDir: string): LoginCommands {
  const dbPath = accountDbPath(configDir);
  return {
    bash: `${CONSOLE_LOGIN_VARIABLE}='${quoteBash(dbPath)}' ${CONSOLE_LOGIN_COMMAND}`,
    powershell: `$env:${CONSOLE_LOGIN_VARIABLE}='${quotePowershell(dbPath)}'; ${CONSOLE_LOGIN_COMMAND}`,
    hint: CONSOLE_LOGIN_HINT,
  };
}

export function loginCommands(
  provider: ProviderId,
  configDir: string,
): LoginCommands | null {
  const spec = LOGIN_SPECS[provider];
  if (spec === undefined) {
    return null;
  }
  const { variable, command, hint } = spec;
  if (variable === null) {
    return { bash: command, powershell: command, hint };
  }
  return {
    bash: `${variable}='${quoteBash(configDir)}' ${command}`,
    powershell: `$env:${variable}='${quotePowershell(configDir)}'; ${command}`,
    hint,
  };
}
