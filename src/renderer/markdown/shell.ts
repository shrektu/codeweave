export const SHELL_LANGUAGES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "console",
  "shellsession",
]);

export const COMMON_COMMANDS: ReadonlySet<string> = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "node",
  "python",
  "python3",
  "pip",
  "uv",
  "cd",
  "ls",
  "cat",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "curl",
  "wget",
  "docker",
  "make",
  "cargo",
  "go",
  "sudo",
  "apt",
  "brew",
  "export",
  "echo",
  "gh",
  "kubectl",
  "bun",
  "deno",
]);

export const MAX_COMMAND_LINES = 20;

const PROMPT = "$";
const PROMPT_PREFIX = "$ ";
const CONTINUATION = "\\";
const CARRIAGE_RETURN_LINE_BREAK = /\r\n?/g;
const WHITESPACE = /\s+/;
const PS2_MARKER = ">";
const PS2_PREFIX = "> ";
const LEADING_TABS = /^\t+/;
const HEREDOC_OPERATOR =
  /(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|([^\s'"<>|&;()]+))/g;

export const ShellLineKind = {
  command: "command",
  output: "output",
} as const;
export type ShellLineKind = (typeof ShellLineKind)[keyof typeof ShellLineKind];

export interface ShellLine {
  readonly kind: ShellLineKind;
  readonly text: string;
}

function normalised(text: string): string {
  return text.replace(CARRIAGE_RETURN_LINE_BREAK, "\n").replace(/\n+$/, "");
}

function isPromptLine(line: string): boolean {
  return line === PROMPT || line.startsWith(PROMPT_PREFIX);
}

function promptStripped(line: string): string {
  return line.slice(PROMPT_PREFIX.length);
}

function isShellLanguage(language: string | null): boolean {
  return language !== null && SHELL_LANGUAGES.has(language.toLowerCase());
}

function startsWithCommonCommand(line: string): boolean {
  const [word = ""] = line.trim().split(WHITESPACE);
  return COMMON_COMMANDS.has(word);
}

export function looksLikeCommand(text: string): boolean {
  const lines = normalised(text)
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (lines.length === 0 || lines.length > MAX_COMMAND_LINES) {
    return false;
  }
  return lines.every(
    (line, index) =>
      isPromptLine(line) ||
      startsWithCommonCommand(line) ||
      lines[index - 1]?.endsWith(CONTINUATION) === true,
  );
}

export function isShellBlock(language: string | null, text: string): boolean {
  return language === null ? looksLikeCommand(text) : isShellLanguage(language);
}

interface Heredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

function heredocsIn(command: string): Heredoc[] {
  return Array.from(command.matchAll(HEREDOC_OPERATOR), (match) => ({
    delimiter: match[2] ?? match[3] ?? match[4] ?? "",
    stripTabs: match[1] === "-",
  }));
}

function isContinuationMarker(line: string): boolean {
  return line === PS2_MARKER || line.startsWith(PS2_PREFIX);
}

function ps2Stripped(line: string): string {
  return line.slice(PS2_PREFIX.length);
}

function closesHeredoc(heredoc: Heredoc, line: string): boolean {
  const content = heredoc.stripTabs ? line.replace(LEADING_TABS, "") : line;
  return content === heredoc.delimiter;
}

interface ParseState {
  readonly heredocs: Heredoc[];
  continued: boolean;
  afterCommand: boolean;
}

function commandText(line: string, state: ParseState): string | null {
  if (state.heredocs.length > 0) {
    return isContinuationMarker(line) ? ps2Stripped(line) : line;
  }
  if (line === PROMPT) {
    return null;
  }
  if (line.startsWith(PROMPT_PREFIX)) {
    return promptStripped(line);
  }
  if (state.continued) {
    return line;
  }
  return state.afterCommand && isContinuationMarker(line)
    ? ps2Stripped(line)
    : null;
}

export function shellLines(text: string): ShellLine[] {
  const lines = normalised(text).split("\n");
  if (!lines.some(isPromptLine)) {
    return lines.map((line) => ({ kind: ShellLineKind.command, text: line }));
  }
  const parsed: ShellLine[] = [];
  const state: ParseState = {
    heredocs: [],
    continued: false,
    afterCommand: false,
  };
  for (const line of lines) {
    const command = commandText(line, state);
    if (command === null) {
      state.afterCommand = false;
      state.continued = false;
      if (line !== PROMPT) {
        parsed.push({ kind: ShellLineKind.output, text: line });
      }
      continue;
    }
    parsed.push({ kind: ShellLineKind.command, text: command });
    state.afterCommand = true;
    const [heredoc] = state.heredocs;
    if (heredoc === undefined) {
      state.continued = command.endsWith(CONTINUATION);
      state.heredocs.push(...heredocsIn(command));
    } else {
      state.continued = false;
      if (closesHeredoc(heredoc, command)) {
        state.heredocs.shift();
      }
    }
  }
  return parsed;
}

export function shellCommandText(text: string): string {
  return shellLines(text)
    .filter((line) => line.kind === ShellLineKind.command)
    .map((line) => line.text)
    .join("\n");
}
