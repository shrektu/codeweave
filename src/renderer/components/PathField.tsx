import { File, FolderOpen, History, Pencil } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { displayPath, splitPath } from "../paths";
import { useAsyncAction, type AsyncAction } from "../useAsyncAction";

import { Icon } from "./Icon";

export type PathKind = "folder" | "file";

export interface PathFieldProps {
  value: string | null;
  onChange: (path: string) => void;
  kind: PathKind;
  label: string;
  id?: string;
  recent: readonly string[];
  disabled?: boolean;
  chooseLabel?: string;
  placeholder?: string;
  primary?: boolean;
  trailing?: ReactNode;
}

const DEFAULT_CHOOSE_LABEL = "Choose…";
const ESCAPE_KEY = "Escape";

function PathText({ path }: { path: string }): JSX.Element {
  const { homeDir, platform } = window.codeweave;
  const { head, tail } = splitPath(
    displayPath(path, homeDir, platform),
    platform,
  );
  return (
    <>
      <span className="path-head" data-tail-length={tail.length}>
        {head}
      </span>
      <span className="path-tail">{tail}</span>
    </>
  );
}

function RecentMenu({
  recent,
  disabled,
  onPick,
}: {
  recent: readonly string[];
  disabled: boolean;
  onPick: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return (): void => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || event.key !== ESCAPE_KEY) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="path-recent" ref={rootRef} onKeyDown={closeOnEscape}>
      <button
        ref={toggleRef}
        type="button"
        className="btn"
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon icon={History} />
        Recent
      </button>
      {open && (
        <ul className="path-recent-menu" id={listId}>
          {recent.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="path-recent-item"
                title={path}
                onClick={() => {
                  setOpen(false);
                  onPick(path);
                }}
              >
                <PathText path={path} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PathEditor({
  id,
  initial,
  onApply,
}: {
  id: string | undefined;
  initial: string;
  onApply: (path: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="path-edit">
      <input
        id={id}
        type="text"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onApply(draft);
          }
        }}
      />
      <button
        type="button"
        className="btn"
        onClick={() => {
          onApply(draft);
        }}
      >
        Use path
      </button>
    </div>
  );
}

function PathValue({
  value,
  placeholder,
}: {
  value: string | null;
  placeholder: string | undefined;
}): JSX.Element | null {
  if (value !== null) {
    return (
      <span className="path-value" title={value}>
        <PathText path={value} />
      </span>
    );
  }
  return placeholder === undefined ? null : (
    <span className="path-value path-placeholder">{placeholder}</span>
  );
}

interface ChooseButtonProps {
  kind: PathKind;
  pick: AsyncAction;
  disabled: boolean;
  chooseLabel: string | undefined;
  primary: boolean | undefined;
  onPicked: (path: string) => void;
}

function ChooseButton({
  kind,
  pick,
  disabled,
  chooseLabel = DEFAULT_CHOOSE_LABEL,
  primary = false,
  onPicked,
}: ChooseButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={primary ? "btn pri" : "btn"}
      disabled={disabled || pick.pending}
      onClick={() => {
        void pick.run(async () => {
          const picked = await (kind === "folder"
            ? window.codeweave.pickFolder()
            : window.codeweave.pickFile());
          if (picked !== null) {
            onPicked(picked);
          }
        });
      }}
    >
      <Icon icon={kind === "folder" ? FolderOpen : File} />
      {chooseLabel}
    </button>
  );
}

export function PathField({
  value,
  onChange,
  kind,
  label,
  id,
  recent,
  disabled = false,
  chooseLabel,
  placeholder,
  primary,
  trailing,
}: PathFieldProps): JSX.Element {
  const pick = useAsyncAction();
  const [editing, setEditing] = useState(false);

  return (
    <div className="path-field" role="group" aria-label={`${label} path`}>
      <div className="path-row">
        <PathValue value={value} placeholder={placeholder} />
        <div className="path-actions">
          <ChooseButton
            kind={kind}
            pick={pick}
            disabled={disabled}
            chooseLabel={chooseLabel}
            primary={primary}
            onPicked={onChange}
          />
          {kind === "folder" && recent.length > 0 && (
            <RecentMenu recent={recent} disabled={disabled} onPick={onChange} />
          )}
          <button
            type="button"
            className="btn plain"
            aria-expanded={editing}
            disabled={disabled}
            onClick={() => {
              setEditing(!editing);
            }}
          >
            <Icon icon={Pencil} />
            Edit path
          </button>
          {trailing}
        </div>
      </div>
      {editing && (
        <PathEditor
          id={id}
          initial={value ?? ""}
          onApply={(path) => {
            setEditing(false);
            onChange(path);
          }}
        />
      )}
      {pick.error !== null && <p className="error">{pick.error}</p>}
    </div>
  );
}
