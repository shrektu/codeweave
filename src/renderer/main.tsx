import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./tokens.css";
import "./app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { connectedClient } from "./ipc";
import { ServicesContext } from "./services";
import { createAppStore } from "./store";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Missing #root element");
}

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
