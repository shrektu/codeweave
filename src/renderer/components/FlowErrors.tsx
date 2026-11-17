import type { JSX } from "react";

import type { FlowFileError } from "../../shared/views";

export function FlowErrors({
  errors,
}: {
  errors: readonly FlowFileError[];
}): JSX.Element {
  return (
    <ul className="flow-errors">
      {errors.map((error) => (
        <li key={error.file} className="error">
          {`Could not read ${error.file}: ${error.messages.join("; ")}`}
        </li>
      ))}
    </ul>
  );
}
