import type { JSX } from "react";

export function EditFeedback({
  errors,
  conflict,
  conflictMessage,
  saveError,
  onReload,
}: {
  errors: readonly string[];
  conflict: boolean;
  conflictMessage: string;
  saveError: string | null;
  onReload: () => void;
}): JSX.Element {
  return (
    <>
      <ul className="flow-errors">
        {errors.map((message) => (
          <li key={message} className="error">
            {message}
          </li>
        ))}
      </ul>
      {conflict && (
        <p className="error" role="alert">
          {conflictMessage}{" "}
          <button type="button" className="btn" onClick={onReload}>
            Reload
          </button>
        </p>
      )}
      {saveError !== null && <p className="error">{saveError}</p>}
    </>
  );
}
