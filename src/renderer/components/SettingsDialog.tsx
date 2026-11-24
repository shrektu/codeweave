import { useState, type JSX, type ReactNode } from "react";

import {
  Appearance,
  EffectLevel,
  PermissionProfile,
  ProviderId,
  UpdateChannel,
} from "../../domain/types";
import { parseTaskClass, TASK_CLASS_ORDER } from "../../domain/taskClass";
import { EXECUTABLE_SETTING_LABELS } from "../../shared/constants";
import type { ParamsMap } from "../../shared/protocol";
import type { SettingsView } from "../../shared/views";
import { PROFILE_OPTIONS } from "../profileOptions";
import { TASK_CLASS_LABELS } from "../routingText";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";
import { useRecentFolders } from "../useRecentFolders";

import { Dialog, type DialogProps } from "./Dialog";
import { PathField, type PathKind } from "./PathField";
import { RadioOption } from "./RadioOption";

type SettingsPatch = ParamsMap["settings/set"];

interface PatchProps {
  settings: SettingsView;
  onPatch: (patch: SettingsPatch) => void;
}

const APPEARANCE_OPTIONS: readonly { value: Appearance; label: string }[] = [
  { value: Appearance.system, label: "System" },
  { value: Appearance.light, label: "Light" },
  { value: Appearance.dark, label: "Dark" },
];

const EFFECT_OPTIONS: readonly { value: EffectLevel; label: string }[] = [
  { value: EffectLevel.auto, label: "Auto" },
  { value: EffectLevel.low, label: "Low" },
  { value: EffectLevel.full, label: "Full" },
];

const CHANNEL_OPTIONS: readonly { value: UpdateChannel; label: string }[] = [
  { value: UpdateChannel.stable, label: "Stable" },
  { value: UpdateChannel.beta, label: "Beta (pre-releases)" },
];

const BYPASS_WARNING =
  "In Bypass mode the agent never asks, so Codeweave cannot block dangerous commands.";

function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <fieldset className="settings-group">
      <legend className="sec">{title}</legend>
      <div className="group">{children}</div>
    </fieldset>
  );
}

function ProfileFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <SettingsGroup title="Permission profile">
      {PROFILE_OPTIONS.map((option) => (
        <RadioOption
          key={option.value}
          group="permission-profile"
          label={option.label}
          description={option.description}
          checked={settings.permissionProfile === option.value}
          onSelect={() => {
            onPatch({ permissionProfile: option.value });
          }}
        />
      ))}
      {settings.permissionProfile === PermissionProfile.bypass && (
        <p className="warning">{BYPASS_WARNING}</p>
      )}
    </SettingsGroup>
  );
}

function AppearanceFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <SettingsGroup title="Appearance">
      {APPEARANCE_OPTIONS.map((option) => (
        <RadioOption
          key={option.value}
          group="appearance"
          label={option.label}
          checked={settings.appearance === option.value}
          onSelect={() => {
            onPatch({ appearance: option.value });
          }}
        />
      ))}
    </SettingsGroup>
  );
}

function EffectsFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <SettingsGroup title="Visual effects">
      {EFFECT_OPTIONS.map((option) => (
        <RadioOption
          key={option.value}
          group="effect-level"
          label={option.label}
          checked={settings.effectLevel === option.value}
          onSelect={() => {
            onPatch({ effectLevel: option.value });
          }}
        />
      ))}
    </SettingsGroup>
  );
}

function RoutingFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <SettingsGroup title="Task routing">
      <label className="group-row">
        Default task class
        <select
          value={settings.defaultTaskClass}
          onChange={(event) => {
            const defaultTaskClass = parseTaskClass(event.target.value);
            if (defaultTaskClass !== null) {
              onPatch({ defaultTaskClass });
            }
          }}
        >
          {TASK_CLASS_ORDER.map((taskClass) => (
            <option key={taskClass} value={taskClass}>
              {TASK_CLASS_LABELS[taskClass]}
            </option>
          ))}
        </select>
      </label>
    </SettingsGroup>
  );
}

function UpdatesFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <SettingsGroup title="Updates">
      <label className="group-row check-row">
        <input
          type="checkbox"
          checked={settings.updateCheck}
          onChange={(event) => {
            onPatch({ updateCheck: event.target.checked });
          }}
        />
        Check for updates
      </label>
      {CHANNEL_OPTIONS.map((option) => (
        <RadioOption
          key={option.value}
          group="update-channel"
          label={option.label}
          checked={settings.updateChannel === option.value}
          disabled={!settings.updateCheck}
          onSelect={() => {
            onPatch({ updateChannel: option.value });
          }}
        />
      ))}
    </SettingsGroup>
  );
}

interface ExecutableFieldProps {
  id: string;
  label: string;
  current: string | null;
  kind?: PathKind;
  placeholder?: string;
  help?: string;
  onSave: (value: string | null) => void;
}

function ExecutableField({
  id,
  label,
  current,
  kind = "file",
  placeholder = "Found on PATH",
  help,
  onSave,
}: ExecutableFieldProps): JSX.Element {
  const [path, setPath] = useState(current ?? "");
  const recent = useRecentFolders();
  return (
    <div className="field group-row">
      <label htmlFor={id}>{label}</label>
      {help !== undefined && <p className="empty">{help}</p>}
      <div className="field-control">
        <PathField
          id={id}
          kind={kind}
          label={label}
          value={path === "" ? null : path}
          placeholder={placeholder}
          recent={recent}
          onChange={setPath}
          trailing={
            <button
              type="button"
              className="btn"
              onClick={() => {
                onSave(path === "" ? null : path);
              }}
            >
              Save
            </button>
          }
        />
      </div>
    </div>
  );
}

function SettingsForm({ settings }: { settings: SettingsView }): JSX.Element {
  const { client } = useApp();
  const save = useAsyncAction();
  const onPatch = (patch: SettingsPatch): void => {
    void save.run(() => client.request("settings/set", patch));
  };

  return (
    <>
      <ProfileFieldset settings={settings} onPatch={onPatch} />
      <AppearanceFieldset settings={settings} onPatch={onPatch} />
      <EffectsFieldset settings={settings} onPatch={onPatch} />
      <RoutingFieldset settings={settings} onPatch={onPatch} />
      <UpdatesFieldset settings={settings} onPatch={onPatch} />
      <SettingsGroup title="Agent executables">
        <ExecutableField
          id="claude-executable"
          label={EXECUTABLE_SETTING_LABELS[ProviderId.claude]}
          current={settings.claudeExecutable}
          onSave={(claudeExecutable) => {
            onPatch({ claudeExecutable });
          }}
        />
        <ExecutableField
          id="codex-executable"
          label={EXECUTABLE_SETTING_LABELS[ProviderId.codex]}
          current={settings.codexExecutable}
          onSave={(codexExecutable) => {
            onPatch({ codexExecutable });
          }}
        />
        <ExecutableField
          id="opencode-executable"
          label={EXECUTABLE_SETTING_LABELS[ProviderId.opencode]}
          current={settings.opencodeExecutable}
          onSave={(opencodeExecutable) => {
            onPatch({ opencodeExecutable });
          }}
        />
        <ExecutableField
          id="agy-executable"
          label={EXECUTABLE_SETTING_LABELS[ProviderId.gemini]}
          current={settings.agyExecutable}
          onSave={(agyExecutable) => {
            onPatch({ agyExecutable });
          }}
        />
      </SettingsGroup>
      <SettingsGroup title="Terminal and library">
        <ExecutableField
          id="terminal-shell"
          label="Terminal shell"
          current={settings.terminalShell}
          placeholder="Detected automatically"
          help="Leave empty to detect your shell automatically."
          onSave={(terminalShell) => {
            onPatch({ terminalShell });
          }}
        />
        <ExecutableField
          id="definition-library"
          kind="folder"
          label="Agents and flows library"
          current={settings.definitionLibrary}
          placeholder="Default: Codeweave data folder/library"
          help="Where this Codeweave instance stores your agents and flows. A project folder's definitions override library ones with the same id."
          onSave={(definitionLibrary) => {
            onPatch({ definitionLibrary });
          }}
        />
        <ExecutableField
          id="default-workspace"
          kind="folder"
          label="Default workspace"
          current={settings.defaultWorkspace}
          placeholder={`Home folder (${settings.defaultWorkspaceResolved})`}
          help="Where a session starts when you do not choose a folder."
          onSave={(defaultWorkspace) => {
            onPatch({ defaultWorkspace });
          }}
        />
      </SettingsGroup>
      {save.error !== null && <p className="error">{save.error}</p>}
    </>
  );
}

export function SettingsDialog({ onClose }: DialogProps): JSX.Element {
  const { state } = useApp();
  const settings = state.snapshot?.settings ?? null;

  return (
    <Dialog title="Settings" onClose={onClose}>
      {settings !== null && <SettingsForm settings={settings} />}
    </Dialog>
  );
}
