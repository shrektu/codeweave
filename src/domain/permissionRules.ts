export const SEGMENT_OPERATORS: readonly string[] = ["|", "||", "&&", ";"];
export const PIPE_OPERATOR = "|";
export const UNPARSEABLE_SUBSTRINGS: readonly string[] = [
  "$(",
  "`",
  "<(",
  ">(",
  "\n",
  "\r",
];
export const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const ENV_COMMAND = "env";
export const RISKY_ENV_NAME_PATTERN = /^(LD_|DYLD_|GIT_)/;
export const RISKY_ENV_NAMES: readonly string[] = [
  "PATH",
  "PAGER",
  "MANPAGER",
  "EDITOR",
  "VISUAL",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "NODE_OPTIONS",
  "PERL5OPT",
  "RUBYOPT",
  "PYTHONSTARTUP",
];
export const ENV_SETTING_BUILTINS: readonly string[] = [
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "read",
  "let",
  "mapfile",
  "readarray",
];
export const PRINTF_COMMAND = "printf";
export const PRINTF_VARIABLE_FLAG = "-v";
export const DECLARATION_BUILTINS: readonly string[] = [
  "declare",
  "typeset",
  "local",
];
export const DECLARATION_ATTRIBUTE_PATTERN = /^[-+][A-Za-z]*[in]/;
export const SUBSCRIPT_OPEN = "[";
export const CONFIG_HOME_ENV_NAMES: readonly string[] = [
  "HOME",
  "XDG_CONFIG_HOME",
];
export const ENV_IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/g;
export const REDIRECT_OPERATORS: readonly string[] = [
  ">",
  ">>",
  ">|",
  "&>",
  ">&",
  "<",
  "<&",
  "<>",
];
export const FD_DUPLICATION_OPERATORS: readonly string[] = [">&", "<&"];
export const INPUT_REDIRECT_OPERATORS: readonly string[] = ["<"];
export const FD_TARGET_PATTERN = /^(\d+|-)$/;
export const HARMLESS_WRITE_TARGETS: readonly string[] = [
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
];
export const NETWORK_DEVICE_PREFIXES: readonly string[] = [
  "/dev/tcp/",
  "/dev/udp/",
];
export const FD_PREFIX_PATTERN = /^\d+$/;
export const UNRESOLVED_PATH_PREFIX = "~";
export const VARIABLE_MARKER = "$";

export const RUNTIME_WORD_PATTERN = /[$`*?[{]|^~/;
export const OPAQUE_COMMANDS: readonly string[] = [
  "eval",
  "source",
  ".",
  "builtin",
  "busybox",
  "watch",
  "flock",
  "unshare",
  "nsenter",
  "chroot",
  "setpriv",
  "strace",
  "ltrace",
  "parallel",
  "runuser",
  "script",
  "systemd-run",
];

export const PRIVILEGE_COMMANDS: readonly string[] = [
  "sudo",
  "sudoedit",
  "doas",
  "su",
  "pkexec",
  "run0",
];
export const COMMAND_ALIAS_PREFIX = "=";
export const COMMAND_ALIAS_PATTERN = /^=/;
export const TRUSTED_BIN_DIRS: readonly string[] = [
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/usr/sbin",
  "/sbin",
];
export const CWD_COMMANDS: readonly string[] = ["cd", "pushd", "popd"];
export const CD_COMMAND = "cd";
export const POPD_COMMAND = "popd";
export const OPTIONS_END = "--";
export const CD_OPTION_FLAGS: readonly string[] = ["-L", "-P", "-e", "-@"];
export const CHAIN_OPERATOR = "&&";
export const OR_OPERATOR = "||";
export const CD_ENV_NAMES: readonly string[] = ["home", "cdpath"];
export const APPEND_ASSIGNMENT_SUFFIX = /\+$/;
export const STACK_OFFSET_PATTERN = /^\+\d+$/;
export const PATH_WILDCARD = "*";
export const HOME_RELATIVE_PREFIX = "~/";
export const HOME_RELATIVE_PREFIX_WIN32 = "~\\";
export const CASE_FOLDED_PLATFORMS: readonly string[] = ["win32", "darwin"];
export const WIN32_PLATFORM = "win32";
export const POSIX_SEPARATOR = "/";
export const WIN32_SEPARATOR = "\\";
export const ASSIGNMENT_SEPARATOR = "=";

export interface WrapperSpec {
  readonly valueShort: string;
  readonly optionalShort: string;
  readonly flagShort: string;
  readonly valueLong: readonly string[];
  readonly flagLong: readonly string[];
  readonly splitShort: string;
  readonly splitLong: readonly string[];
  readonly positional: number;
  readonly injectsArgs: boolean;
  readonly writeOptions: readonly string[];
  readonly chdirOptions: readonly string[];
}

function wrapperSpec(overrides: Partial<WrapperSpec>): WrapperSpec {
  return {
    valueShort: "",
    optionalShort: "",
    flagShort: "",
    valueLong: [],
    flagLong: [],
    splitShort: "",
    splitLong: [],
    positional: 0,
    injectsArgs: false,
    writeOptions: [],
    chdirOptions: [],
    ...overrides,
  };
}

export const WRAPPER_SPECS: ReadonlyMap<string, WrapperSpec> = new Map([
  [
    "env",
    wrapperSpec({
      valueShort: "uC",
      flagShort: "i0v",
      valueLong: ["unset", "chdir"],
      flagLong: ["ignore-environment", "null", "debug"],
      splitShort: "S",
      splitLong: ["split-string"],
      chdirOptions: ["-C", "--chdir"],
    }),
  ],
  ["exec", wrapperSpec({ valueShort: "a", flagShort: "cl" })],
  [
    "time",
    wrapperSpec({
      valueShort: "of",
      flagShort: "pvaq",
      valueLong: ["output", "format"],
      flagLong: ["portability", "verbose", "append", "quiet"],
      writeOptions: ["-o", "--output"],
    }),
  ],
  [
    "nice",
    wrapperSpec({
      valueShort: "n",
      flagShort: "0123456789",
      valueLong: ["adjustment"],
    }),
  ],
  [
    "timeout",
    wrapperSpec({
      valueShort: "sk",
      flagShort: "v",
      valueLong: ["signal", "kill-after"],
      flagLong: ["foreground", "preserve-status", "verbose"],
      positional: 1,
    }),
  ],
  [
    "stdbuf",
    wrapperSpec({
      valueShort: "ioe",
      valueLong: ["input", "output", "error"],
    }),
  ],
  ["nohup", wrapperSpec({})],
  [
    "setsid",
    wrapperSpec({
      flagShort: "cfw",
      flagLong: ["ctty", "fork", "wait"],
    }),
  ],
  [
    "ionice",
    wrapperSpec({
      valueShort: "cn",
      flagShort: "t",
      valueLong: ["class", "classdata"],
      flagLong: ["ignore"],
    }),
  ],
  [
    "chrt",
    wrapperSpec({
      flagShort: "bfiorRva",
      flagLong: [
        "batch",
        "fifo",
        "idle",
        "other",
        "rr",
        "reset-on-fork",
        "verbose",
      ],
      positional: 1,
    }),
  ],
  [
    "taskset",
    wrapperSpec({ flagShort: "c", flagLong: ["cpu-list"], positional: 1 }),
  ],
  [
    "xargs",
    wrapperSpec({
      valueShort: "nLPsIdEa",
      optionalShort: "ile",
      flagShort: "0rtpxo",
      valueLong: [
        "max-args",
        "max-procs",
        "max-lines",
        "max-chars",
        "delimiter",
        "arg-file",
        "eof",
      ],
      flagLong: [
        "null",
        "no-run-if-empty",
        "verbose",
        "interactive",
        "exit",
        "open-tty",
      ],
      injectsArgs: true,
    }),
  ],
  ["command", wrapperSpec({ flagShort: "pvV" })],
]);
export const SHELL_COMMANDS: readonly string[] = [
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "mksh",
  "fish",
  "csh",
  "tcsh",
];
export const SHELL_PLAIN_FLAGS: readonly string[] = [
  "--login",
  "--norc",
  "--noprofile",
];
export const SHELL_SHORT_CLUSTER_PATTERN = /^-[eulxc]+$/;
export const SHELL_COMMAND_LETTER = "c";
export const SHELL_VALUE_FLAG = "-o";
export const SHELL_OPTIONS_END_WORDS: readonly string[] = ["--", "-"];
export const OPTION_PREFIX_PATTERN = /^[-+]/;
export const NON_COMMAND_WORDS: readonly string[] = [
  "!",
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  ",",
  "{",
  "}",
  "[[",
  "]]",
  "((",
];
export const DASH_PREFIX = "-";
export const BRACE_EXPANSION_PATTERN = /\{.*(?:,|\.\.).*\}/;
export const GLOB_CHAR_PATTERN = /[*?[]/;
export const UNREPORTED_GLOB_START_PATTERN = /^[?[]/;
export const UNSUPPORTED_WHITESPACE_PATTERN = /[^\S \t]/u;
export const FIND_COMMAND = "find";
export const FIND_EXEC_FLAGS: readonly string[] = [
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
];
export const FIND_EXEC_TERMINATOR = ";";
export const FIND_EXEC_BATCH_TERMINATOR = "+";
export const FIND_PLACEHOLDER = "{}";
export const DOWNLOAD_COMMANDS: readonly string[] = ["curl", "wget"];
export const INTERPRETER_COMMANDS: readonly string[] = [
  "python",
  "python3",
  "perl",
  "node",
  "ruby",
  "php",
  "deno",
  "bun",
  "lua",
  "Rscript",
  "pwsh",
];
export const VERSION_SUFFIX_PATTERN = /[0-9.]+$/;
export const PROTECTED_BRANCHES: readonly string[] = [
  "main",
  "master",
  "develop",
];
export const READ_ONLY_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "wc",
  "pwd",
  "which",
  "echo",
];
export const READ_ONLY_FORBIDDEN_FLAGS: ReadonlyMap<string, readonly string[]> =
  new Map([["rg", ["--pre", "--pre-glob", "--hostname-bin"]]]);
export const GIT_EXEC_FLAGS: readonly string[] = ["--ext-diff"];
export const FIND_FILES0_FLAG = "-files0-from";
export const FIND_ASK_FLAGS: readonly string[] = [
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
];
export const GIT_READ_SUBCOMMANDS: readonly string[] = [
  "status",
  "log",
  "diff",
  "show",
];
export const GIT_BRANCH_SUBCOMMAND = "branch";
export const GIT_OUTPUT_FLAG = "--output";
export const GIT_BRANCH_LIST_FLAGS: readonly string[] = ["--list", "-l"];
export const GIT_BRANCH_LISTING_FLAGS: readonly string[] = [
  ...GIT_BRANCH_LIST_FLAGS,
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--color",
  "--no-color",
];
export const GIT_BRANCH_COMMIT_FILTER_FLAGS: readonly string[] = [
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
];
export const GIT_BRANCH_INLINE_VALUE_PREFIXES: readonly string[] = [
  "--sort=",
  "--format=",
  "--color=",
  "--column=",
];
export const GIT_BRANCH_LISTING_CLUSTER = /^-[avr]+$/;
export const GIT_CONFIG_OPTIONS: readonly string[] = ["-c", "--config-env"];
export const GIT_CONFIG_ATTACHED_PREFIX = "-c";
export const GIT_OPTIONS_WITH_PATH_ARGUMENT: readonly string[] = ["-C"];
export const GIT_SAFE_GLOBAL_OPTIONS: readonly string[] = [
  "--no-pager",
  "--no-optional-locks",
  "-P",
];
export const GIT_PUSH_DANGEROUS_LETTERS: readonly string[] = ["f", "d"];
export const GIT_PUSH_FORBIDDEN_LONG_FLAGS: readonly string[] = [
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--all",
  "--branches",
  "--delete",
  "--prune",
];
export const GIT_PUSH_VALUE_OPTIONS: readonly string[] = [
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
  "--repo",
  "--recurse-submodules",
];
export const GIT_PUSH_VALUE_LETTERS: readonly string[] =
  GIT_PUSH_VALUE_OPTIONS.filter((option) => !option.startsWith("--")).map(
    (option) => option.slice(1),
  );
export const GIT_PUSH_PROGRAM_OPTIONS: readonly string[] = [
  "--receive-pack",
  "--exec",
];
export const GIT_PUSH_CURRENT_BRANCH_SOURCES: readonly string[] = ["HEAD", "@"];
export const REFS_PREFIX_PATTERN = /^refs[/]/;
export const HEADS_PREFIX_PATTERN = /^heads[/]/;

export const RM_RECURSIVE_FLAGS: readonly string[] = ["--recursive", "--force"];
export const RM_LONG_PREFIX_MIN_LENGTH = 3;
export const RM_SHORT_FLAG_LETTERS: readonly string[] = ["r", "R", "f"];

export const MIGRATION_COMMANDS: readonly (readonly string[])[] = [
  ["liquibase", "update"],
  ["flyway", "migrate"],
  ["prisma", "migrate", "deploy"],
  ["alembic", "upgrade"],
  ["knex", "migrate:latest"],
];

export const REASON_PRIVILEGE = "privilege escalation is blocked";
export const REASON_PLAN_NO_WRITES = "plan mode: no writes";
export const REASON_RM_OUTSIDE =
  "recursive or forced delete outside the worktree is blocked";
export const REASON_RM_PROTECTED =
  "recursive or forced delete of a protected path is blocked";
export const REASON_GIT_PUSH = "forced or protected-branch push is blocked";
export const REASON_PIPE_TO_SHELL = "piping a download into a shell is blocked";
export const REASON_MIGRATION = "database migrations are blocked";

export function isRiskyEnvName(name: string): boolean {
  return RISKY_ENV_NAME_PATTERN.test(name) || RISKY_ENV_NAMES.includes(name);
}

function isGitSensitiveEnvName(name: string): boolean {
  return isRiskyEnvName(name) || CONFIG_HOME_ENV_NAMES.includes(name);
}

function isGitSensitiveEnvWord(word: string): boolean {
  const identifiers = word.match(ENV_IDENTIFIER_PATTERN) ?? [];
  return identifiers.some(isGitSensitiveEnvName);
}

function commandWords(words: readonly string[]): readonly string[] {
  const start = words.findIndex((word) => !NON_COMMAND_WORDS.includes(word));
  return start === -1 ? [] : words.slice(start);
}

function assignsPrintfVariable(args: readonly string[]): boolean {
  const flag = args.indexOf(PRINTF_VARIABLE_FLAG);
  const target = flag === -1 ? undefined : args[flag + 1];
  return target !== undefined && isGitSensitiveEnvWord(target);
}

export function setsGitSensitiveEnv(words: readonly string[]): boolean {
  const [first, ...args] = commandWords(words);
  return (
    first !== undefined &&
    ((ENV_SETTING_BUILTINS.includes(first) &&
      args.some(isGitSensitiveEnvWord)) ||
      (first === PRINTF_COMMAND && assignsPrintfVariable(args)) ||
      (DECLARATION_BUILTINS.includes(first) &&
        args.some((word) => DECLARATION_ATTRIBUTE_PATTERN.test(word))))
  );
}

export function hasGitSensitiveSubscript(words: readonly string[]): boolean {
  return words.some((word) => {
    const open = word.indexOf(SUBSCRIPT_OPEN);
    return open !== -1 && isGitSensitiveEnvWord(word.slice(open));
  });
}

export function hasGitSensitivePrefix(words: readonly string[]): boolean {
  const rest = commandWords(words);
  const end = rest.findIndex((word) => !ENV_ASSIGNMENT_PATTERN.test(word));
  return (end === -1 ? rest : rest.slice(0, end)).some(isGitSensitiveEnvWord);
}
