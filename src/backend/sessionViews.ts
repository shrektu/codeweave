import type { EventName, EventPayloadMap } from "../shared/protocol";
import type { SessionView } from "../shared/views";

import type { ConnectionRegistry } from "./connections";

type ViewListener = (view: SessionView | null) => void;

interface ViewMessage<E extends EventName> {
  readonly event: E;
  readonly payload: EventPayloadMap[E];
}

export interface ViewObserver {
  readonly broadcast: ConnectionRegistry["broadcast"];
  readonly listen: (listener: ViewListener) => () => void;
}

const SESSION_CHANGED_EVENT = "session/changed";

function carriesSessionView<E extends EventName>(
  message: ViewMessage<E>,
): message is {
  readonly event: E;
  readonly payload: EventPayloadMap[E] & (SessionView | null);
} {
  return message.event === SESSION_CHANGED_EVENT;
}

export function observeViews(
  broadcast: ConnectionRegistry["broadcast"],
): ViewObserver {
  const listeners = new Set<ViewListener>();
  return {
    broadcast: (event, payload) => {
      broadcast(event, payload);
      const message = { event, payload };
      if (carriesSessionView(message)) {
        listeners.forEach((listener) => {
          listener(message.payload);
        });
      }
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
