import type { JSX } from "react";

import type { DefinitionSource } from "../../domain/types";
import { DEFINITION_SOURCE_LABELS } from "../format";

export function SourceBadge({
  source,
}: {
  source: DefinitionSource;
}): JSX.Element {
  return (
    <span className="source-badge" data-source={source}>
      {DEFINITION_SOURCE_LABELS[source]}
    </span>
  );
}
