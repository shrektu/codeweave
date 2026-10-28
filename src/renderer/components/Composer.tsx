import { useState, type JSX, type KeyboardEvent } from "react";

import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

export function Composer(): JSX.Element {
  const { client, state } = useApp();
  const [text, setText] = useState("");
  const send = useAsyncAction();
  const session = state.snapshot?.session ?? null;
  const enabled =
    state.connection === "ready" &&
    session?.phase.phase === "running" &&
    !session.turnInFlight &&
    !send.pending;

  const submit = async (): Promise<void> => {
    if (!enabled || text.trim() === "") {
      return;
    }
    const sent = await send.run(() =>
      client.request("session/prompt", { text }),
    );
    if (sent) {
      setText("");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        placeholder="Describe the task"
        value={text}
        disabled={!enabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {send.error !== null && <p className="error">{send.error}</p>}
      <button
        type="button"
        className="send"
        aria-label="Send"
        disabled={!enabled || text.trim() === ""}
        onClick={() => {
          void submit();
        }}
      >
        ↑
      </button>
    </div>
  );
}
