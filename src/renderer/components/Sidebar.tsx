import type { JSX } from "react";

import type { SampleAccount } from "../sampleData";

interface SidebarProps {
  accounts: readonly SampleAccount[];
}

export function Sidebar({ accounts }: SidebarProps): JSX.Element {
  return (
    <section className="glass panel" aria-label="Konta">
      <h2 className="sec">Konta</h2>
      <ul>
        {accounts.map((account) => (
          <li
            key={account.id}
            className="item"
            data-provider={account.provider}
          >
            <span className="dot" />
            {account.name}
            <small>{account.kind}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
