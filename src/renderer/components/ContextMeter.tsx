import type { JSX } from "react";

import type { ProviderId } from "../../domain/types";
import type { ContextUsageView } from "../../shared/views";
import { contextUsageText } from "../format";

export interface ContextMeterProps {
  readonly usage: ContextUsageView | null;
  readonly provider: ProviderId;
}

export function ContextMeter({
  usage,
  provider,
}: ContextMeterProps): JSX.Element {
  const limit = usage?.limitTokens ?? null;
  return (
    <span
      className="context-meter"
      title={
        usage === null
          ? `${provider} has not reported context usage for this session`
          : undefined
      }
    >
      {usage !== null && limit !== null && (
        <meter min={0} max={limit} value={usage.usedTokens} />
      )}
      <span>{contextUsageText(usage)}</span>
    </span>
  );
}
