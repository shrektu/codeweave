import type { SlashCommandLibrary } from "../../src/backend/slashCommands";

export function fakeSlashCommands(
  overrides: Partial<SlashCommandLibrary> = {},
): SlashCommandLibrary {
  return {
    list: () => Promise.resolve({ commands: [], errors: [] }),
    ...overrides,
  };
}
