import type { JSX } from "react";

import type { SampleMessage, SampleToolCard } from "../sampleData";

interface SessionStreamProps {
  messages: readonly SampleMessage[];
  toolCard: SampleToolCard;
}

export function SessionStream({
  messages,
  toolCard,
}: SessionStreamProps): JSX.Element {
  return (
    <section className="glass panel" aria-label="Sesja">
      <h2 className="sec">Sesja</h2>
      <ul className="stream">
        {messages.map((message) => (
          <li
            key={message.id}
            className="card"
            data-provider={message.provider}
          >
            <div className="card-author">{message.author}</div>
            {message.text}
          </li>
        ))}
        <li className="card tool">
          <div className="tool-head">
            <b>{toolCard.tool}</b>
            {toolCard.target}
            <span className="tool-status">{toolCard.status}</span>
          </div>
          <pre className="diff">
            {toolCard.diff.map((line) => (
              <span key={line.text} className={`diff-${line.kind}`}>
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        </li>
      </ul>
    </section>
  );
}
