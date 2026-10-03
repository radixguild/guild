// Browser entry point — bundled (via `bun build`, see package.json's
// `build-verifier` script) into profile/verifier.bundle.js. This is the
// SAME source as the Node/Bun-side jcs.ts/did-key.ts/verify.ts (imported
// directly, not reimplemented), so the in-page verifier can never drift
// from the library's own logic the way a hand-ported copy could.

import { canonicalize } from './jcs.js';
import { verifyCredential, type VerifyResult } from './verify.js';
import type { TaskSettlementCredential } from './schema.js';

declare global {
  // eslint-disable-next-line no-var
  var SettlementCredential:
    | {
        canonicalize: typeof canonicalize;
        verifyCredential: typeof verifyCredential;
      }
    | undefined;
}

globalThis.SettlementCredential = { canonicalize, verifyCredential };

export type { VerifyResult, TaskSettlementCredential };
