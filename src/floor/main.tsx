// Stub (Slice 0). The Floor's entry. The floor-shell lane builds the page from Slice 1, track 1F.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";

function NotBuilt() {
  return (
    <main className="not-built">
      <h1>Premise</h1>
      <p>The Floor is not built yet.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The page has no #root element.");
}
createRoot(root).render(
  <StrictMode>
    <NotBuilt />
  </StrictMode>,
);
