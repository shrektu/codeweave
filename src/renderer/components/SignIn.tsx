import type { JSX } from "react";

import { ApiAuth } from "../../domain/apiProviders";
import type { AccountView } from "../../shared/views";
import {
  consoleLoginCommands,
  loginCommands,
  type LoginCommands,
} from "../loginCommand";

function commandsFor(account: AccountView): LoginCommands | null {
  return account.api?.auth === ApiAuth.consoleLogin
    ? consoleLoginCommands(account.configDir)
    : loginCommands(account.provider, account.configDir);
}

export function SignIn({
  account,
}: {
  account: AccountView;
}): JSX.Element | null {
  const commands = commandsFor(account);
  if (commands === null) {
    return null;
  }
  return (
    <div className="signin">
      <b>Sign in</b>
      <p>{commands.hint}</p>
      <div className="cmd">
        <span>bash</span>
        <code>{commands.bash}</code>
      </div>
      <div className="cmd">
        <span>PowerShell</span>
        <code>{commands.powershell}</code>
      </div>
    </div>
  );
}
