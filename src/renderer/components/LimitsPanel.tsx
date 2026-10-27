import type { JSX } from "react";

import type { SampleLimit } from "../sampleData";

interface LimitsPanelProps {
  limits: readonly SampleLimit[];
}

export function LimitsPanel({ limits }: LimitsPanelProps): JSX.Element {
  return (
    <section className="glass panel" aria-label="Limity">
      <h2 className="sec">Limity</h2>
      {limits.map((limit) => (
        <div key={limit.id} className="meter">
          <div className="meter-head">
            <span>{limit.label}</span>
            <span>{limit.percent}%</span>
          </div>
          <div
            className="bar"
            role="progressbar"
            aria-label={limit.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={limit.percent}
          >
            <i style={{ width: `${limit.percent.toString()}%` }} />
          </div>
          <span>{limit.resetsIn}</span>
        </div>
      ))}
    </section>
  );
}
