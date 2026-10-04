// The one place registry tags resolve to components (the registry contract of `registry.ts`):
// this file merges the three Floor lanes' `wiring/*.views.tsx` records. `app.tsx` looks a
// registered entry's `value` up here — it imports no lane component itself through the seam.

import type { ReactNode } from "react";
import { views as shell } from "./wiring/shell.views.tsx";
import { views as rail } from "./wiring/rail.views.tsx";
import { views as poolArea } from "./wiring/pool-area.views.tsx";

export type RegistryComponent = (props: Record<string, unknown>) => ReactNode;

export const COMPONENTS: Record<string, RegistryComponent> = { ...shell, ...rail, ...poolArea };
