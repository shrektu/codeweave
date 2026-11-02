import { ProviderId } from "../domain/types";

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
  const bashDir = configDir.replaceAll(SINGLE_QUOTE, BASH_ESCAPED_QUOTE);
  const powershellDir = configDir.replace(
    POWERSHELL_SINGLE_QUOTES,
    (quote) => quote + quote,
  );
  return {
    bash: `${variable}='${bashDir}' ${command}`,
    powershell: `$env:${variable}='${powershellDir}'; ${command}`,
    hint,
  };
}
