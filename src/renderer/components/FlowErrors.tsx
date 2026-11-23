import type { JSX } from "react";

import type { FlowFileError } from "../../shared/views";
import { DEFINITION_SOURCE_LABELS } from "../format";

export function FlowErrors({
  errors,
}: {
  errors: readonly FlowFileError[];
}): JSX.Element {
  return (
    <ul className="flow-errors">
      {errors.map((error) => (
        <li key={`${error.source}:${error.file}`} className="error">
          {`Could not read ${error.file} (${DEFINITION_SOURCE_LABELS[error.source]}): ${error.messages.join("; ")}`}
        </li>
      ))}
    </ul>
  );
}
