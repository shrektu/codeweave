const SINGLE_QUOTE = "'";
const BASH_ESCAPED_QUOTE = "'\\''";
const POWERSHELL_SINGLE_QUOTES = /['‘’‚‛]/g;

export interface LoginCommands {
  bash: string;
  powershell: string;
}

export function loginCommands(configDir: string): LoginCommands {
  const bashDir = configDir.replaceAll(SINGLE_QUOTE, BASH_ESCAPED_QUOTE);
  const powershellDir = configDir.replace(
    POWERSHELL_SINGLE_QUOTES,
    (quote) => quote + quote,
  );
  return {
    bash: `CLAUDE_CONFIG_DIR='${bashDir}' claude`,
    powershell: `$env:CLAUDE_CONFIG_DIR='${powershellDir}'; claude`,
  };
}
