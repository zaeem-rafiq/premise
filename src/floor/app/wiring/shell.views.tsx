// The shell lane's tag→component bindings (the registry contract of `../registry.ts`): each
// registered entry's `value` is its own name, a tag, and this record binds those tags to the
// components. `app.tsx` resolves tags only through `../bindings.tsx`, never by importing this
// file directly — the wiring module itself stays JSX-free for the Node test program.

import type { ReactNode } from "react";
import type { FloorState } from "../../../protocol/reducer/state.ts";
import { SwarmView } from "../../components/swarm/swarm.tsx";

export const views: Record<string, (props: Record<string, unknown>) => ReactNode> = {
  "view.swarm": (props) => (
    <SwarmView floor={props.floor as FloorState} owner={props.owner === true} pool={String(props.pool)} />
  ),
};
