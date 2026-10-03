import type { Page, BrowserContext, APIRequestContext, Route } from "@playwright/test";

/**
 * True when the app's own API (and therefore Postgres) is reachable. A local
 * checkout without DATABASE_URL skips DB-backed assertions instead of failing on
 * connection errors. Grep marker: needs-db.
 *
 * CI is DIFFERENT: the e2e job is contracted to provision a migrated Postgres
 * (test.yml `services.postgres` + `db:migrate`). If the DB is unreachable there,
 * a skip would be a FALSE GREEN — the DB-backed specs silently vanish and the run
 * still passes. So under `CI` we HARD-FAIL instead of skipping (M11): a broken
 * service / wrong DATABASE_URL / failed migrate surfaces as red, not as green.
 */
/**
 * Is the chain halted right now, per the app's own probe?
 *
 * Specs that drive a task-lifecycle WRITE need this: as of the P1 write-side gate
 * (src/lib/chain-halt-gate.ts) those routes refuse with 503 CHAIN_HALTED while the ledger
 * tip is stalled, and that read happens SERVER-side — `stubPostingStatus` and friends
 * intercept browser fetches and cannot reach it. Rather than skip (this file's own
 * dbAvailable comment is right that a silent skip is a false green), a spec asks this and
 * asserts the correct outcome for whichever state the chain is actually in.
 */
export async function chainHalted(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get("/api/v1/network/status");
    const body = await res.json();
    return body?.data?.halted === true;
  } catch {
    // Unknown reads as not-halted — the same fail-open posture the gate itself takes.
    return false;
  }
}

export async function dbAvailable(request: APIRequestContext): Promise<boolean> {
  const available = await probeDb(request);
  if (!available && process.env.CI) {
    throw new Error(
      "DB unreachable under CI — the e2e job MUST provide a migrated Postgres " +
        "(see .github/workflows/test.yml: services.postgres + db:migrate). Refusing " +
        "to silently skip DB-backed specs (that would be a false green). Check the " +
        "postgres service health, DATABASE_URL, and the migrate step.",
    );
  }
  return available;
}

async function probeDb(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.get("/api/v1/tasks?limit=1");
    if (!res.ok()) return false;
    const body = await res.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Guides render as a modal whose overlay intercepts pointer events, so specs
 * pre-mark every guide as dismissed via localStorage before any page script
 * runs. /tasks no longer auto-opens its guide (2026-09-20 — see user-flows.spec.ts
 * "never cover the board uninvited"); this stays as a guard for the pages that
 * can still open one.
 */
const ALL_GUIDE_IDS = ["mint", "tasks", "profile", "admin"];

export async function dismissGuides(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript((ids: string[]) => {
    window.localStorage.setItem("guild-guides-dismissed", JSON.stringify(ids));
  }, ALL_GUIDE_IDS);
}

/**
 * A fixture account for the mock wallet — this repo's already-public
 * dApp-definition account (same address the gift rails use as a fixture), never
 * a real signing destination. The mock never signs; the address is only the
 * identity the ROLA sign-in and the created task's poster resolve to.
 */
export const MOCK_ACCOUNT =
  "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw";

/**
 * Install a mock RadixDappToolkit before any app script runs, so browser
 * money-path specs run without a real Radix wallet. The mock (grep marker:
 * e2e-wallet-mock):
 *   - reports one connected account (MOCK_ACCOUNT) via walletData$,
 *   - completes ROLA sign-in: sendOneTimeRequest() calls the app-registered
 *     challenge generator (a real server-issued nonce) and returns a proof the
 *     e2e server accepts without a signature check (a GUILD_E2E_BUILD=1 build run
 *     with GUILD_E2E_AUTH_BYPASS=1, both set by playwright.config.ts; see src/lib/rola.ts),
 *   - records every manifest the app sends on window.__GUILD_E2E_SENT_MANIFESTS__
 *     so a test can replay it against tests/support/mock-ledger.ts.
 * useWallet.tsx's createDappToolkit() picks this up via window.__GUILD_E2E_RDT__;
 * the global is set only here, so the seam is dead code in every real build.
 */
export async function injectWalletMock(
  target: Page | BrowserContext,
  account = MOCK_ACCOUNT,
): Promise<void> {
  await target.addInitScript((acct: string) => {
    const w = window as unknown as {
      __GUILD_E2E_RDT__?: () => unknown;
      __GUILD_E2E_SENT_MANIFESTS__?: string[];
    };
    const sent: string[] = [];
    w.__GUILD_E2E_SENT_MANIFESTS__ = sent;
    const ok = (value: unknown) => ({
      isOk: () => true,
      isErr: () => false,
      value,
    });
    let challengeGen: () => Promise<string> = async () => "0".repeat(64);
    let txN = 0;
    const walletApi = {
      provideChallengeGenerator(fn: () => Promise<string>) {
        challengeGen = fn;
      },
      setRequestData() {},
      walletData$: {
        subscribe(cb: (data: { accounts: { address: string }[] }) => void) {
          cb({ accounts: [{ address: acct }] });
          return { unsubscribe() {} };
        },
      },
      async sendOneTimeRequest() {
        const challenge = await challengeGen();
        return ok({
          proofs: [
            {
              type: "account",
              address: acct,
              challenge,
              proof: {
                publicKey: "0".repeat(64),
                signature: "0".repeat(128),
                curve: "curve25519",
              },
            },
          ],
        });
      },
      async sendTransaction({ transactionManifest }: { transactionManifest: string }) {
        sent.push(transactionManifest);
        return ok({ transactionIntentHash: `txid_e2e_${++txN}` });
      },
    };
    w.__GUILD_E2E_RDT__ = () => ({ walletApi, destroy() {} });
  }, account);
}

/**
 * Canned third-party responses for specs that assert Gateway/bot-API-backed
 * UI. Grep marker: chain-stub.
 *
 * /profile/[address] gates on a live mainnet Gateway badge lookup
 * (src/lib/gateway.ts loadUserBadge). When that host is slow from CI runners,
 * the loading skeletons outlive the specs' 15s expect timeouts and the whole
 * group fails "element(s) not found" — same code, different Gateway weather
 * (compare CI runs 27268703215 red vs 27311583483 green). stubChainData()
 * pins every external host to a canned state so these specs test OUR
 * rendering, not upstream availability.
 *
 * (The /decisions listings — src/components/governance/on-chain-governance.tsx
 * — used to be the other consumer here, with a canned CV2 check and a stub
 * for the bot's cv2/proposals route. Both were removed 2026-09-04 along with
 * the page: nothing in the app calls that bot-API route any more, so stubbing
 * it would be dead weight. CV3's stubs went the same way earlier, when CV3
 * was parked 2026-07-18.)
 */

// Fulfilled routes are still subject to the browser's CORS checks (these are
// cross-origin fetches from localhost:3000), so every response needs the
// allow-origin header and POST+JSON preflights need an explicit 204.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function fulfillJson(route: Route, status: number, body: unknown) {
  if (route.request().method() === "OPTIONS") {
    return route.fulfill({ status: 204, headers: CORS_HEADERS });
  }
  return route.fulfill({
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function stubChainData(target: Page | BrowserContext): Promise<void> {
  // Gateway catch-all: 500 models "Gateway unavailable" — a state the app
  // demonstrably tolerates (RDT init and badge reads all fail soft; green CI
  // runs include Gateway-down days). Registered first so the more specific
  // routes below win (Playwright matches routes in reverse registration order).
  await target.route("https://mainnet.radixdlt.com/**", (route) =>
    fulfillJson(route, 500, {})
  );
  // Badge lookup (POST /state/entity/details): a malformed address gets a 400
  // from the real Gateway; loadUserBadge maps !ok → null → "No badge found".
  await target.route("**/state/entity/details", (route) =>
    fulfillJson(route, 400, { message: "Invalid address" })
  );
  // Bot API (BOT_API_URL, src/lib/config.ts) — matched by path so a
  // NEXT_PUBLIC_API_URL override is stubbed all the same.
  await target.route("**/contributors/**", (route) =>
    fulfillJson(route, 200, { ok: true, data: { tasks: [] } })
  );
}

/**
 * Answer the fungible holding read behind the /admin gate
 * (holdsFungibleBadgeResult in src/lib/gateway.ts) with one vault per amount:
 * `[]` is an account that never held the resource, `["1"]` the operator badge.
 * Same response shape as the mainnet Gateway. Call AFTER stubChainData, so this
 * route wins over its Gateway catch-all.
 */
export async function stubFungibleVaults(
  target: Page | BrowserContext,
  amounts: string[]
): Promise<void> {
  await target.route("**/state/entity/page/fungible-vaults/", (route) =>
    fulfillJson(route, 200, {
      total_count: amounts.length,
      items: amounts.map((amount) => ({
        vault_address: "internal_vault_rdx1e2estub",
        amount,
        last_updated_at_state_version: 1,
      })),
    })
  );
}

/**
 * Pin the app's own posting-status probe to a known answer. The probe's chain
 * read happens SERVER-side (readXrdPostingFrozen), so stubChainData's Gateway
 * routes can't reach it — and while W3 keeps the live escrow frozen, an
 * unstubbed run renders the paused notice instead of the Fund Escrow button,
 * failing money-path specs on live chain state rather than our rendering.
 */
export async function stubPostingStatus(
  target: Page | BrowserContext,
  frozen: boolean | null
): Promise<void> {
  await target.route("**/api/v1/escrow/posting-status*", (route) =>
    fulfillJson(route, 200, { ok: true, data: { component: "stub", frozen } })
  );
}
