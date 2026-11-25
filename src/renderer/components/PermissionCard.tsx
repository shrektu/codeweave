import type { JSX } from "react";

import type { PermissionView } from "../../shared/views";
import { shownSessionOf } from "../format";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

const ALLOW_ONCE_KIND = "allow_once";

export interface PermissionCardProps {
  permission: PermissionView;
  sessionId?: string | null;
  runId?: string | null;
}

export function PermissionCard({
  permission,
  sessionId = null,
  runId = null,
}: PermissionCardProps): JSX.Element {
  const { client, state } = useApp();
  const answer = useAsyncAction();
  const targetSessionId =
    sessionId ??
    state.activeSessionId ??
    shownSessionOf(state.snapshot, state.activeSessionId, state.focusedRunId)
      .session?.id ??
    null;
  const primaryOptionId = permission.options.find(
    (option) => option.kind === ALLOW_ONCE_KIND,
  )?.optionId;

  return (
    <div className="card tool ask">
      <div className="tool-head">
        <b>Needs approval</b>
        <span>{permission.title}</span>
      </div>
      {permission.command !== undefined && <pre>{permission.command}</pre>}
      <div className="row">
        {permission.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={option.optionId === primaryOptionId ? "btn pri" : "btn"}
            disabled={answer.pending}
            onClick={() => {
              void answer.run(() =>
                client.request("permission/answer", {
                  requestId: permission.requestId,
                  optionId: option.optionId,
                  ...(runId !== null
                    ? { runId }
                    : targetSessionId !== null
                      ? { sessionId: targetSessionId }
                      : {}),
                }),
              );
            }}
          >
            {option.name}
          </button>
        ))}
      </div>
      {answer.error !== null && <p className="error">{answer.error}</p>}
    </div>
  );
}
