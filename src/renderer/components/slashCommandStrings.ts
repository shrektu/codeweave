export const SLASH_COMMAND_STRINGS = {
  listLabel: "Slash commands",
  builtinDescription: {
    clear: "New session in this folder; keep current in history",
    compact: "Summarize conversation to free context",
    model: "Set model override with /model <name>, or focus model",
    resume: "Continue an earlier session from history",
    rewind: "Restore files or conversation from the latest prompt",
  },
  kindLabel: { prompt: "Prompt", skill: "Skill" },
  sourceLabel: { project: "Project", library: "Library" },
  resumeEmpty: "No earlier sessions",
  resumeOptionDescription: (folder: string, when: string) =>
    `${folder} · ${when}`,
  noMatches: "No matching commands; sending passes text as-is",
  loadErrors: (count: number) =>
    `${String(count)} command ${count === 1 ? "file" : "files"} could not be read and ${count === 1 ? "was" : "were"} skipped`,
  compactFailed: (message: string) => `Could not compact: ${message}`,
  clearFailed: (message: string) => `Could not start new session: ${message}`,
  commandArgumentsHint: "Text after the command is passed as arguments",
} as const;
