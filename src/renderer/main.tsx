import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/sidebar.css";
import "./styles/stream.css";
import "./styles/flow.css";
import "./styles/dialogs.css";
import "./styles/terminal.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Appearance } from "../domain/types";

import { App } from "./App";
import { connectedClient } from "./ipc";
import { ServicesContext } from "./services";
import { createAppStore } from "./store";
import {
  applyTheme,
  readStoredAppearance,
  resolveTheme,
  systemPrefersDark,
} from "./theme";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Missing #root element");
}

applyTheme(
  resolveTheme(
    readStoredAppearance() ?? Appearance.system,
    systemPrefersDark(),
  ),
);

void connectedClient.then((client) => {
  const store = createAppStore(client);
  store.start();
  createRoot(container).render(
    <StrictMode>
      <ServicesContext value={{ client, store }}>
        <App />
      </ServicesContext>
    </StrictMode>,
  );
});
