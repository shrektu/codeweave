import { useEffect, useEffectEvent, useId, useState, type JSX } from "react";

import {
  OVERWRITABLE_SKIP_REASONS,
  RestoreAction,
  RestoreSkipReason,
  RewindMode,
} from "../../domain/checkpoints";
import type {
  PromptView,
  RestorePlanFileView,
  RestorePlanView,
  RestoreReportView,
  RewindResultView,
} from "../../shared/views";
import type { IpcClient } from "../ipc";
import { useApp } from "../services";
import { useAsyncAction, type AsyncAction } from "../useAsyncAction";

import { Dialog } from "./Dialog";
import { RadioOption } from "./RadioOption";

export const REWIND_STRINGS = {
  rewindButton: "Rewind to here",
  dialogTitle: "Rewind session",
  modeConversationAndFiles: "Conversation and files",
  modeConversationAndFilesHint:
    "Remove the conversation from this prompt onward and restore files edited by agents since then.",
  modeConversation: "Conversation only",
  modeConversationHint:
    "Remove the conversation from this prompt onward and leave files as they are.",
  modeFiles: "Files only",
  modeFilesHint:
    "Restore files edited by agents since this prompt and keep the conversation.",
  resumeNote:
    "After a conversation rewind, the agent continues from a summary of the remaining conversation without its own session memory.",
  limitsNote:
    "Only file edits made through agent edit tools and recorded by Codeweave are undone. Shell commands, their side effects (installed packages, deleted or moved files, git operations), and changes made outside Codeweave are not undone.",
  sectionRestore: "Files to restore",
  sectionDelete: "Created files to delete",
  sectionConflict: "Files changed outside the agent",
  overwriteCheckbox: "Overwrite anyway",
  sectionUnrestorable: "Files that cannot be restored",
  reasonUnverifiable:
    "Codeweave cannot check the current content because the file is binary or too large.",
  reasonBinary: "Binary file",
  reasonTooLarge: "File is over 1 MB",
  reasonNotReported: "The agent did not report what it changed.",
  reasonPatchMismatch: "The recorded change no longer matches the file.",
  reasonEvicted:
    "The saved copy was dropped to stay within the checkpoint size limit.",
  reasonProtected: "Protected location (such as app data or account folders).",
  noFiles: "No recorded file edits since this prompt.",
  loadingPreview: "Loading preview…",
  confirm: "Rewind",
  cancel: "Cancel",
  reportSummary:
    "Rewind complete: {restored} restored, {deleted} deleted, {skipped} skipped.",
} as const;

const REASON_LABELS: Record<RestoreSkipReason, string> = {
  [RestoreSkipReason.conflict]: REWIND_STRINGS.sectionConflict,
  [RestoreSkipReason.unverifiable]: REWIND_STRINGS.reasonUnverifiable,
  [RestoreSkipReason.binary]: REWIND_STRINGS.reasonBinary,
  [RestoreSkipReason.tooLarge]: REWIND_STRINGS.reasonTooLarge,
  [RestoreSkipReason.notReported]: REWIND_STRINGS.reasonNotReported,
  [RestoreSkipReason.patchMismatch]: REWIND_STRINGS.reasonPatchMismatch,
  [RestoreSkipReason.evicted]: REWIND_STRINGS.reasonEvicted,
  [RestoreSkipReason.protected]: REWIND_STRINGS.reasonProtected,
};

interface ModeOption {
  readonly value: RewindMode;
  readonly label: string;
  readonly hint: string;
}

const MODE_OPTIONS: readonly ModeOption[] = [
  {
    value: RewindMode.conversationAndFiles,
    label: REWIND_STRINGS.modeConversationAndFiles,
    hint: REWIND_STRINGS.modeConversationAndFilesHint,
  },
  {
    value: RewindMode.conversation,
    label: REWIND_STRINGS.modeConversation,
    hint: REWIND_STRINGS.modeConversationHint,
  },
  {
    value: RewindMode.files,
    label: REWIND_STRINGS.modeFiles,
    hint: REWIND_STRINGS.modeFilesHint,
  },
];

function modeHasConversation(mode: RewindMode): boolean {
  return mode !== RewindMode.files;
}

function modeHasFiles(mode: RewindMode): boolean {
  return mode !== RewindMode.conversation;
}

type SkippedFile = RestorePlanFileView & { readonly skip: RestoreSkipReason };

function isOverwritableFile(file: RestorePlanFileView): file is SkippedFile {
  return file.skip !== null && OVERWRITABLE_SKIP_REASONS.includes(file.skip);
}

function isUnrestorableFile(file: RestorePlanFileView): file is SkippedFile {
  return file.skip !== null && !OVERWRITABLE_SKIP_REASONS.includes(file.skip);
}

export function rewindReportSummary(report: RestoreReportView): string {
  return REWIND_STRINGS.reportSummary
    .replace("{restored}", String(report.restored.length))
    .replace("{deleted}", String(report.deleted.length))
    .replace("{skipped}", String(report.skipped.length));
}

interface FileSectionProps {
  readonly title: string;
  readonly paths: readonly string[];
}

function FileSection({ title, paths }: FileSectionProps): JSX.Element {
  return (
    <section>
      <h3>{title}</h3>
      <ul>
        {paths.map((path) => (
          <li key={path}>{path}</li>
        ))}
      </ul>
    </section>
  );
}

interface ConflictSectionProps {
  readonly files: readonly SkippedFile[];
  readonly overwrite: ReadonlySet<string>;
  readonly onToggle: (path: string, checked: boolean) => void;
}

function ConflictSection({
  files,
  overwrite,
  onToggle,
}: ConflictSectionProps): JSX.Element {
  return (
    <section>
      <h3>{REWIND_STRINGS.sectionConflict}</h3>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <span>{file.path}</span>
            {file.skip === RestoreSkipReason.unverifiable && (
              <small>{REWIND_STRINGS.reasonUnverifiable}</small>
            )}
            <label>
              <input
                type="checkbox"
                checked={overwrite.has(file.path)}
                onChange={(event) => {
                  onToggle(file.path, event.target.checked);
                }}
              />
              {REWIND_STRINGS.overwriteCheckbox}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UnrestorableSection({
  files,
}: {
  readonly files: readonly SkippedFile[];
}): JSX.Element {
  return (
    <section>
      <h3>{REWIND_STRINGS.sectionUnrestorable}</h3>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <span>{file.path}</span>
            <small>{REASON_LABELS[file.skip]}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface FileSectionsProps {
  readonly plan: RestorePlanView;
  readonly overwrite: ReadonlySet<string>;
  readonly onToggle: (path: string, checked: boolean) => void;
}

function FileSections({
  plan,
  overwrite,
  onToggle,
}: FileSectionsProps): JSX.Element {
  const restorable = plan.files.filter(
    (file) => file.skip === null && file.action === RestoreAction.write,
  );
  const deletable = plan.files.filter(
    (file) => file.skip === null && file.action === RestoreAction.delete,
  );
  const conflicts = plan.files.filter(isOverwritableFile);
  const unrestorable = plan.files.filter(isUnrestorableFile);
  const listed =
    restorable.length +
    deletable.length +
    conflicts.length +
    unrestorable.length;

  return (
    <>
      {listed === 0 && <p className="empty">{REWIND_STRINGS.noFiles}</p>}
      {restorable.length > 0 && (
        <FileSection
          title={REWIND_STRINGS.sectionRestore}
          paths={restorable.map((file) => file.path)}
        />
      )}
      {deletable.length > 0 && (
        <FileSection
          title={REWIND_STRINGS.sectionDelete}
          paths={deletable.map((file) => file.path)}
        />
      )}
      {conflicts.length > 0 && (
        <ConflictSection
          files={conflicts}
          overwrite={overwrite}
          onToggle={onToggle}
        />
      )}
      {unrestorable.length > 0 && <UnrestorableSection files={unrestorable} />}
    </>
  );
}

interface RewindPreviewProps {
  readonly plan: RestorePlanView;
  readonly mode: RewindMode;
  readonly overwrite: ReadonlySet<string>;
  readonly onMode: (mode: RewindMode) => void;
  readonly onToggle: (path: string, checked: boolean) => void;
}

function RewindPreview({
  plan,
  mode,
  overwrite,
  onMode,
  onToggle,
}: RewindPreviewProps): JSX.Element {
  const group = useId();
  return (
    <>
      {MODE_OPTIONS.map((option) => (
        <RadioOption
          key={option.value}
          group={group}
          label={option.label}
          description={option.hint}
          checked={mode === option.value}
          onSelect={() => {
            onMode(option.value);
          }}
        />
      ))}
      {modeHasConversation(mode) && (
        <p className="empty">{REWIND_STRINGS.resumeNote}</p>
      )}
      <p className="empty">{REWIND_STRINGS.limitsNote}</p>
      {modeHasFiles(mode) && (
        <FileSections plan={plan} overwrite={overwrite} onToggle={onToggle} />
      )}
    </>
  );
}

interface RewindContentProps {
  readonly preview: AsyncAction;
  readonly rewind: AsyncAction;
  readonly plan: RestorePlanView | null;
  readonly mode: RewindMode;
  readonly overwrite: ReadonlySet<string>;
  readonly onMode: (mode: RewindMode) => void;
  readonly onToggle: (path: string, checked: boolean) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

function RewindContent({
  preview,
  rewind,
  plan,
  mode,
  overwrite,
  onMode,
  onToggle,
  onConfirm,
  onClose,
}: RewindContentProps): JSX.Element {
  return (
    <>
      {preview.pending && (
        <p className="empty">{REWIND_STRINGS.loadingPreview}</p>
      )}
      {preview.error !== null && <p className="error">{preview.error}</p>}
      {plan !== null && (
        <RewindPreview
          plan={plan}
          mode={mode}
          overwrite={overwrite}
          onMode={onMode}
          onToggle={onToggle}
        />
      )}
      {rewind.error !== null && <p className="error">{rewind.error}</p>}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          disabled={rewind.pending}
          onClick={onClose}
        >
          {REWIND_STRINGS.cancel}
        </button>
        <button
          type="button"
          className="btn pri"
          disabled={plan === null || rewind.pending}
          onClick={onConfirm}
        >
          {REWIND_STRINGS.confirm}
        </button>
      </div>
    </>
  );
}

interface PreviewState {
  readonly plan: RestorePlanView | null;
  readonly preview: AsyncAction;
}

function usePreview(
  client: IpcClient,
  sessionId: string,
  promptSeq: number,
): PreviewState {
  const [plan, setPlan] = useState<RestorePlanView | null>(null);
  const preview = useAsyncAction();
  const load = useEffectEvent(async (): Promise<void> => {
    await preview.run(async () => {
      setPlan(
        await client.request("session/rewindPreview", { sessionId, promptSeq }),
      );
    });
  });
  useEffect(() => {
    void load();
  }, [sessionId, promptSeq]);
  return { plan, preview };
}

export interface RewindDialogProps {
  readonly sessionId: string;
  readonly prompt: PromptView;
  readonly onClose: () => void;
  readonly onRewound: (result: RewindResultView, mode: RewindMode) => void;
}

export function RewindDialog({
  sessionId,
  prompt,
  onClose,
  onRewound,
}: RewindDialogProps): JSX.Element {
  const { client } = useApp();
  const [mode, setMode] = useState<RewindMode>(RewindMode.conversationAndFiles);
  const [overwrite, setOverwrite] = useState<ReadonlySet<string>>(new Set());
  const { plan, preview } = usePreview(client, sessionId, prompt.seq);
  const rewind = useAsyncAction();

  const toggle = (path: string, checked: boolean): void => {
    setOverwrite((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  const confirm = (): void => {
    if (plan === null) {
      return;
    }
    void rewind.run(async () => {
      const result = await client.request("session/rewind", {
        sessionId,
        promptSeq: prompt.seq,
        mode,
        overwrite: [...overwrite],
      });
      onRewound(result, mode);
      onClose();
    });
  };

  const guardClose = (): void => {
    if (!rewind.pending) {
      onClose();
    }
  };

  return (
    <Dialog
      title={REWIND_STRINGS.dialogTitle}
      onClose={guardClose}
      closeDisabled={rewind.pending}
    >
      <RewindContent
        preview={preview}
        rewind={rewind}
        plan={plan}
        mode={mode}
        overwrite={overwrite}
        onMode={setMode}
        onToggle={toggle}
        onConfirm={confirm}
        onClose={onClose}
      />
    </Dialog>
  );
}
