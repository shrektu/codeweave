import { X } from "lucide-react";
import { useEffect, useId, useRef, type JSX, type ReactNode } from "react";

import { Icon } from "./Icon";

export interface DialogProps {
  onClose: () => void;
}

interface DialogFrameProps extends DialogProps {
  title: string;
  children: ReactNode;
}

export function Dialog({
  title,
  onClose,
  children,
}: DialogFrameProps): JSX.Element {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return (): void => {
      dialog?.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="glass dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <Icon icon={X} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
