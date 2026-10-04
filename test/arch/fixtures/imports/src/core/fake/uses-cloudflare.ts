// A negative fixture for test/arch/imports.test.ts (docs/spec/04-build-plan.md 1.3, mechanism 2).
// This file sits under a fake core path and breaks the import allow list on purpose. It is never compiled.

import { DurableObject } from "cloudflare:workers";

export class Fake extends DurableObject {}
