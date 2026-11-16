import { useEffect, useState, type JSX } from "react";

import type { AvailableUpdate } from "../../shared/api";

export function UpdateBanner(): JSX.Element | null {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.codeweave.getAvailableUpdate().then((initial) => {
      if (active) {
        setUpdate((current) => current ?? initial);
      }
    });
    const unsubscribe = window.codeweave.onUpdateAvailable(setUpdate);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (update === null || update.version === dismissed) {
    return null;
  }
  return (
    <div role="status" className="update-banner">
      <span>{`Codeweave ${update.version} is available.`}</span>
      <button
        type="button"
        className="pill"
        onClick={() => {
          void window.codeweave.openUpdateRelease();
        }}
      >
        View release
      </button>
      <button
        type="button"
        className="pill"
        onClick={() => {
          setDismissed(update.version);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
