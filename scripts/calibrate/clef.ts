// `npm run calibrate:clef`: the live calibration of Clef (04-build-plan 2.16 item 2). It calls
// Workers AI and spends the owner's budget, so only the lead runs it. See run.ts.

import { redact } from "../../src/protocol/redact.ts";
import { defaultIo, main } from "./run.ts";

main(process.argv.slice(2), process.env, defaultIo())
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(
      redact(String(error), [process.env.CLOUDFLARE_API_TOKEN ?? "", process.env.CLOUDFLARE_ACCOUNT_ID ?? ""]),
    );
    process.exit(1);
  });
