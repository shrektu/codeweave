import { Download } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import type { AvailableUpdate } from "../../shared/api";

import { ICON_SIZE_SMALL_PX, Icon } from "./Icon";

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
      <Icon icon={Download} size={ICON_SIZE_SMALL_PX} />
      <span className="update-text">{`Codeweave ${update.version} is available.`}</span>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          void window.codeweave.openUpdateRelease();
        }}
      >
        View release
      </button>
      <button
        type="button"
        className="btn plain small"
        onClick={() => {
          setDismissed(update.version);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
