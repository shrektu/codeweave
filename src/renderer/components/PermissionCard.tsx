import type { JSX } from "react";

import type { PermissionView } from "../../shared/views";
import { useApp } from "../services";
import { useAsyncAction } from "../useAsyncAction";

const ALLOW_ONCE_KIND = "allow_once";

export interface PermissionCardProps {
  permission: PermissionView;
}

export function PermissionCard({
  permission,
}: PermissionCardProps): JSX.Element {
  const { client } = useApp();
  const answer = useAsyncAction();
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
