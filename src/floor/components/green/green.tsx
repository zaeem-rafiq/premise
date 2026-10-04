// The green-line state of the pool frame's caption area (3.5, 5.7): the same rows as the
// strip's green cell, drawn under the frame. Signals are shapes and words (6.2): the dot
// changes form, the word stays readable without colour.

import { useContext } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { ShellContext } from "../../app/context.ts";
import { greenRed } from "../../state/derive.ts";

export function GreenLine({ floor }: { floor: FloorState }) {
  const shell = useContext(ShellContext)!;
  const t = shell.t;
  const green = floor.green;
  const feature = shell.settings.features.green;
  let id: string;
  let tone: string;
  if (feature === "none") {
    id = "green.none";
    tone = "neutral";
  } else if (greenRed(floor)) {
    id = "green.red";
    tone = "changed";
  } else if (green.last !== null && !green.last.ok && !green.last.confirmed) {
    id = "green.checking";
    tone = "checking";
  } else if (green.seq === null) {
    return null;
  } else if (green.runtime === "static") {
    id = "green.static";
    tone = "holds";
  } else {
    id = "green.at";
    tone = "holds";
  }
  return (
    <span className="green-line" data-tone={tone}>
      <span className="green-dot" aria-hidden="true" />
      {t(id, { seq: green.seq ?? green.last?.seq ?? 0 })}
    </span>
  );
}
