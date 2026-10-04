// The floor-pool lane's tag→component bindings (the registry contract of `../registry.ts`).
// Bound here when the lane registers entries: `view.compare`, `sheet.why`, `sheet.who`,
// `sheet.undo`. `app.tsx` resolves tags only through `../bindings.tsx`.

export const views: Record<string, never> = {};
