// The seed's modules are plain JavaScript with no declarations (02-tidepool.md TP2). This ambient
// pattern lets the tests import them as `any` without a `@ts-nocheck`.
declare module "../../seeds/*";
