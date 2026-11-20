import type { SessionView } from "../shared/views";

type ViewListener = (view: SessionView | null) => void;

export interface ViewObserver {
  readonly publish: ViewListener;
  readonly listen: (listener: ViewListener) => () => void;
}

export function observeViews(publishView: ViewListener): ViewObserver {
  const listeners = new Set<ViewListener>();
  return {
    publish: (view) => {
      publishView(view);
      listeners.forEach((listener) => {
        listener(view);
      });
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
