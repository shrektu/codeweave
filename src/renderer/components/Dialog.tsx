import { useEffect, useId, useRef, type JSX, type ReactNode } from "react";

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
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      {children}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
