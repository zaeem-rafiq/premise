// The Floor's entry. Loads `/floor.json` once (4.5: the static settings), then renders the
// app for the client route of the address (FE7). The page never reloads between its
// routes; a failed settings load is the one thing that cannot draw (it gets a plain line).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { FloorJson } from "../protocol/floor-json.ts";
import { registry } from "./app/registry.ts";
import { FloorApp } from "./app/app.tsx";
import "./styles/base.css";

async function loadSettings(): Promise<FloorJson | null> {
  try {
    const response = await fetch("/floor.json");
    if (!response.ok) return null;
    return (await response.json()) as FloorJson;
  } catch {
    return null;
  }
}

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The page has no #root element.");
}
const root = createRoot(rootElement);

void loadSettings().then((settings) => {
  root.render(
    <StrictMode>
      {settings === null ? (
        <main className="floor-body floor-loading">
          <p className="floor-loading-line">Premise could not load its settings. Reload the page.</p>
        </main>
      ) : (
        <FloorApp settings={settings} table={registry()} />
      )}
    </StrictMode>,
  );
});
