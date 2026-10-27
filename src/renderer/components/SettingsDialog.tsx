import { useState, type JSX } from "react";

import { EffectLevel, PermissionProfile } from "../../domain/types";
import type { ParamsMap } from "../../shared/protocol";
import type { SettingsView } from "../../shared/views";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

import { Dialog, type DialogProps } from "./Dialog";
import { RadioOption } from "./RadioOption";

type SettingsPatch = ParamsMap["settings/set"];

interface PatchProps {
  settings: SettingsView;
  onPatch: (patch: SettingsPatch) => void;
}

interface ProfileOption {
  value: PermissionProfile;
  label: string;
  description: string;
}

const PROFILE_OPTIONS: readonly ProfileOption[] = [
  {
    value: PermissionProfile.bypass,
    label: "Bypass",
    description: "Claude runs every tool without asking.",
  },
  {
    value: PermissionProfile.unattended,
    label: "Unattended",
    description:
      "Allows reads, edits and commands inside the project; blocks dangerous commands.",
  },
  {
    value: PermissionProfile.acceptEdits,
    label: "Accept edits",
    description: "Allows reads and edits; asks before running commands.",
  },
  {
    value: PermissionProfile.ask,
    label: "Ask",
    description: "Asks before every edit and command.",
  },
  {
    value: PermissionProfile.plan,
    label: "Plan",
    description: "Read-only: edits and commands are denied.",
  },
];

const EFFECT_OPTIONS: readonly { value: EffectLevel; label: string }[] = [
  { value: EffectLevel.auto, label: "Auto" },
  { value: EffectLevel.low, label: "Low" },
  { value: EffectLevel.full, label: "Full" },
];

const BYPASS_WARNING =
  "In Bypass mode Claude never asks, so Codeweave cannot block dangerous commands.";

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

function ExecutableField({ settings, onPatch }: PatchProps): JSX.Element {
  const [executable, setExecutable] = useState(settings.claudeExecutable ?? "");
  return (
    <div className="field">
      <label htmlFor="claude-executable">Claude executable</label>
      <input
        id="claude-executable"
        type="text"
        placeholder="Found on PATH"
        value={executable}
        onChange={(event) => {
          setExecutable(event.target.value);
        }}
      />
      <button
        type="button"
        className="btn"
        onClick={() => {
          onPatch({ claudeExecutable: executable === "" ? null : executable });
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
      <ExecutableField settings={settings} onPatch={onPatch} />
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
