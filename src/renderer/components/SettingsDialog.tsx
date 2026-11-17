import { useState, type JSX } from "react";

import {
  EffectLevel,
  PermissionProfile,
  UpdateChannel,
} from "../../domain/types";
import { parseTaskClass, TASK_CLASS_ORDER } from "../../domain/taskClass";
import type { ParamsMap } from "../../shared/protocol";
import type { SettingsView } from "../../shared/views";
import { PROFILE_OPTIONS } from "../profileOptions";
import { TASK_CLASS_LABELS } from "../routingText";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

import { Dialog, type DialogProps } from "./Dialog";
import { RadioOption } from "./RadioOption";

type SettingsPatch = ParamsMap["settings/set"];

interface PatchProps {
  settings: SettingsView;
  onPatch: (patch: SettingsPatch) => void;
}

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

function ProfileFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <fieldset>
      <legend className="sec">Permission profile</legend>
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
    </fieldset>
  );
}

function EffectsFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <fieldset>
      <legend className="sec">Visual effects</legend>
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
    </fieldset>
  );
}

function RoutingFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <fieldset>
      <legend className="sec">Task routing</legend>
      <label>
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
    </fieldset>
  );
}

function UpdatesFieldset({ settings, onPatch }: PatchProps): JSX.Element {
  return (
    <fieldset>
      <legend className="sec">Updates</legend>
      <label>
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
    </fieldset>
  );
}

interface ExecutableFieldProps {
  id: string;
  label: string;
  current: string | null;
  placeholder?: string;
  help?: string;
  onSave: (value: string | null) => void;
}

function ExecutableField({
  id,
  label,
  current,
  placeholder = "Found on PATH",
  help,
  onSave,
}: ExecutableFieldProps): JSX.Element {
  const [executable, setExecutable] = useState(current ?? "");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {help !== undefined && <p className="empty">{help}</p>}
      <input
        id={id}
        type="text"
        placeholder={placeholder}
        value={executable}
        onChange={(event) => {
          setExecutable(event.target.value);
        }}
      />
      <button
        type="button"
        className="btn"
        onClick={() => {
          onSave(executable === "" ? null : executable);
        }}
      >
        Save
      </button>
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
      <EffectsFieldset settings={settings} onPatch={onPatch} />
      <RoutingFieldset settings={settings} onPatch={onPatch} />
      <UpdatesFieldset settings={settings} onPatch={onPatch} />
      <ExecutableField
        id="claude-executable"
        label="Claude executable"
        current={settings.claudeExecutable}
        onSave={(claudeExecutable) => {
          onPatch({ claudeExecutable });
        }}
      />
      <ExecutableField
        id="codex-executable"
        label="Codex executable"
        current={settings.codexExecutable}
        onSave={(codexExecutable) => {
          onPatch({ codexExecutable });
        }}
      />
      <ExecutableField
        id="opencode-executable"
        label="OpenCode executable"
        current={settings.opencodeExecutable}
        onSave={(opencodeExecutable) => {
          onPatch({ opencodeExecutable });
        }}
      />
      <ExecutableField
        id="agy-executable"
        label="Gemini executable (agy)"
        current={settings.agyExecutable}
        onSave={(agyExecutable) => {
          onPatch({ agyExecutable });
        }}
      />
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
