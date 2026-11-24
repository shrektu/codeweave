# Remaining typed paths

Every filesystem path field in the renderer uses `PathField`
(`src/renderer/components/PathField.tsx`). The typed text input only appears
after the secondary "Edit path" button, and applies with "Use path" or Enter.

## Fields with an "Edit path" fallback

| Place | Component | Kind | Input id |
|---|---|---|---|
| Start prompt, "Choose folder…" | `SessionStream.tsx` `StartPrompt` | folder | none |
| Flow and Agents tabs, "Choose folder…" / "Change folder…" | `FolderControls.tsx` | folder | none |
| Terminal dock, "Open in folder…" | `TerminalDock.tsx` `PickFolderBody` | folder | none |
| Settings, Flow library folder | `SettingsDialog.tsx` `ExecutableField` | folder | `definition-library` |
| Settings, Claude / Codex / OpenCode / Gemini (agy) executables | `SettingsDialog.tsx` `ExecutableField` | file | `claude-executable`, `codex-executable`, `opencode-executable`, `agy-executable` |
| Settings, Terminal shell | `SettingsDialog.tsx` `ExecutableField` | file | `terminal-shell` |
| Accounts, Config directory | `AccountsDialog.tsx` | folder | `account-config-dir` |

## Other text inputs, not filesystem paths

These were checked with a grep for `<input` and `<textarea` under
`src/renderer` and stay typed on purpose.

- `ApiAccountFields.tsx` Base URL (`api-base-url`): an HTTP URL, not a path.
- `FlowRunPanel.tsx` task textarea: free text for the agent.
- `Composer.tsx` model override and prompt: model name and prompt text.
- `AgentForm.tsx` text fields and Instructions: agent id, role and prompt text.
- `AgentModelField.tsx`, `ApiAccountFields.tsx` Model: model identifiers.
- `FlowInspector.tsx` node id and max rounds: flow definition values.

No other place asks for a typed filesystem path.
