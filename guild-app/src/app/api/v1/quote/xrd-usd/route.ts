/**
 * GET /api/v1/quote/xrd-usd — XRD/USD conversion rate quote
 *
 * Primary: Astrolescent (`api.astrolescent.com`)
 * Fallback: CoinGecko (`coingecko.com/api/v3/simple/price`)
 *
 * Response shape:
 * {
 *   rate: number,             // USD per 1 XRD
 *   inverse_rate: number,     // XRD per 1 USD
 *   source: "astrolescent" | "coingecko",
 *   fetched_at: string,       // ISO8601
 *   staleness_seconds: number,
 *   fallback_active: boolean,
 *   primary_frozen: boolean,  // the Radix-priced source has stopped moving
 *   stale: boolean,           // the served PRICE is > 30 min old (see below)
 *   age_seconds: number,      // age of the served PRICE, not of our fetch
 * }
 *
 * On both feeds stale > 5 min: returns 503 with structured error.
 * Cache: 60s server-side TTL. Never returns a rate older than 15 min.
 *
 * ── `stale` / `age_seconds` vs `staleness_seconds` (added 2026-09-03, R1) ──────
 * `staleness_seconds` (above) measures how long ago WE fetched — it is a cache
 * metric and stays near-zero even while re-serving a frozen upstream number,
 * which is exactly the `primary_frozen` bug this file already documents.
 * `age_seconds` measures how old the underlying PRICE itself is, using the
 * price's OWN timestamp where the source provides one:
 *   - CoinGecko: `last_updated_at` (Unix seconds), requested explicitly via
 *     `include_last_updated_at=true`.
 *   - Astrolescent: the partner endpoint has NO price timestamp field at all
 *     (confirmed against its real response shape — address/name/symbol/
 *     tokenPriceXRD/tokenPriceUSD/marketCap, nothing else). The best available
 *     proxy is how long the CURRENTLY-SERVED rate has been unchanged, which is
 *     the exact quantity `notePrimaryRate` below already tracks for frozen
 *     detection — reused here rather than invented twice.
 * `stale` is `age_seconds >= 30 min`. It is deliberately independent of
 * `primary_frozen` (15 min, and about upstream TRUST/selection, not about the
 * served number's own freshness): when Astrolescent freezes and CoinGecko
 * covers for it, `primary_frozen` is true but the SERVED rate is CoinGecko's
 * own fresh quote, so `stale` is false. `stale` only trips when the number
 * actually being returned is old — e.g. both feeds are down and a frozen
 * Astrolescent rate is served past the 30-minute bar.
 *
 * ── WHY `primary_frozen` EXISTS (added 2026-09-02) ───────────────────────────
 * `staleness_seconds` measures how long ago WE fetched. It says nothing about
 * how old the PRICE is, and those came apart badly on 2026-08-31: Radix halted,
 * Astrolescent prices off Radix DEX pools, those pools stopped trading, and the
 * endpoint went on returning HTTP 200 with the last pre-halt trade. This route
 * therefore reported `staleness_seconds: 0` and `fallback_active: false` —
 * declaring itself healthy — while serving a dead number for over fifteen hours.
 *
 * Measured 2026-09-02: our rate was byte-identical (0.000616181090623589)
 * across a ten-hour gap while CoinGecko showed 0.00064639 and -23.24% over 24h.
 * That rate is consumed on /tasks, /tasks/create, /tasks/[id], /mint, /projects
 * and /ledger, so every USD figure on the site was derived from it.
 *
 * The detector is deliberately about the SYMPTOM (a value that has stopped
 * changing) rather than the cause (a network halt). A halt is only one way to
 * freeze this feed — an upstream cache stuck on a stale entry, or a pool with no
 * trades, produce the identical failure and the identical wrong answer. And the
 * one apparent false positive is not one: if the Radix market genuinely has not
 * moved the price in fifteen minutes, a CEX-derived rate is the better input
 * anyway.
 *
 * Design: docs/design/rfp-offers-2026-07-06.md Chunk A
 */

import { NextResponse } from "next/server";
import { XRD_ADDRESS } from "@/lib/radix";
import { evaluateAlert, evaluateNetworkHalt, NETWORK_HALT_ALERT_KEY } from "@/lib/alerts";
import { operatorHaltEngaged, readLedgerTip } from "@/lib/gateway";

// ── Operator alerts — edge-triggered, persisted, inhibited by a network halt ──
// Three incident keys, each evaluated on EVERY uncached pass (true or false)
// so the recovery notice fires by itself. Under the old per-process cooldown
// the frozen-primary alert re-paged every ten minutes for the whole 2026-09
// halt; see src/lib/alert-policy.ts for the rule that replaced it.
const ALERT_FROZEN = "quote-xrd-usd-frozen";
const ALERT_STALE_SERVE = "quote-xrd-usd-stale";
const ALERT_FAIL_CLOSED = "quote-xrd-usd-failclosed";

/** Fire-and-forget: never blocks or throws into the request path. */
function observe(key: string, condition: boolean, title: string, detail?: string): void {
  void (async () => {
    if (key === ALERT_FROZEN && condition) {
      // A frozen DEX-derived price during a halt is the halt, not a second
      // incident. Evaluate the parent first (cached tip read) so inhibition
      // can apply on this very pass.
      await evaluateNetworkHalt(await readLedgerTip(), operatorHaltEngaged());
    }
    await evaluateAlert({
      key,
      condition,
      title,
      detail,
      inhibitedBy: key === ALERT_FROZEN ? NETWORK_HALT_ALERT_KEY : undefined,
    });
  })().catch(() => {});
}

const FROZEN_TITLE = "Price feed: Astrolescent frozen — serving CoinGecko";
const STALE_TITLE = "Price feed: both sources down — serving STALE cache";
const FAIL_CLOSED_TITLE = "Price feed: both sources down — 503 fail-closed";


const ASTROLESCENT_URL = process.env.ASTROLESCENT_PRICE_URL ||
  "https://api.astrolescent.com/partner/radixguild/price?address=" + XRD_ADDRESS;

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price" +
  "?ids=radix&vs_currencies=usd&include_last_updated_at=true";

const CACHE_TTL_MS = 60_000;
const MAX_STALENESS_MS = 15 * 60_000; // 15 min hard cap
const OUTAGE_THRESHOLD_MS = 5 * 60_000; // 5 min triggers fail-closed

/** How old the SERVED price may be before `stale` flips true. See the
 *  `stale` / `age_seconds` doc block above for why this is independent of
 *  PRIMARY_FROZEN_AFTER_MS below. */
const STALE_PRICE_AFTER_MS = 30 * 60_000;

function isStale(ageSeconds: number): boolean {
  return ageSeconds * 1000 >= STALE_PRICE_AFTER_MS;
}

/**
 * How long an unchanged primary rate may persist before we call it frozen.
 *
 * A live AMM-derived quote moves in its low-order digits on essentially every
 * trade, so byte-identical equality sustained over minutes is not a coincidence
 * — it is the signature of a source that has stopped updating. Fifteen minutes
 * matches MAX_STALENESS_MS and leaves generous room for an upstream cache: a
 * price API caching for five minutes looks perfectly healthy under this test.
 */
const PRIMARY_FROZEN_AFTER_MS = 15 * 60_000;

/** The last DISTINCT primary rate, and when we first saw it. `firstSeenAt` does
 *  not advance while the value repeats — that persistence IS the signal. */
let primaryObservation: { rate: number; firstSeenAt: number } | null = null;

/** Test-only: module-level observation state would leak across cases. */
export function __resetPrimaryObservationForTests() {
  primaryObservation = null;
  cache = null;
}

/**
 * Record a primary rate and report whether the source has gone stale-in-place.
 *
 * Returns false on the FIRST sighting of any value, including the first call
 * after a restart. That is deliberate: with no history we cannot know, and
 * declaring a freeze we have not observed would swap one wrong answer for
 * another. It costs at most PRIMARY_FROZEN_AFTER_MS to notice a freeze that was
 * already in progress before we started.
 */
function notePrimaryRate(rate: number, now: number): boolean {
  if (primaryObservation === null || primaryObservation.rate !== rate) {
    primaryObservation = { rate, firstSeenAt: now };
    return false;
  }
  return now - primaryObservation.firstSeenAt >= PRIMARY_FROZEN_AFTER_MS;
}

interface CacheEntry {
  rate: number;
  source: "astrolescent" | "coingecko";
  fetched_at: number;
  // Carried through the cache so the 60s of responses served from it cannot
  // claim health the live read had already disproved.
  primary_frozen: boolean;
  /** Age (seconds) of the underlying PRICE at the moment it was fetched — see
   *  the `stale` / `age_seconds` doc block at the top of this file. Later
   *  reads from this cache entry add elapsed wall-clock time on top: the
   *  price does not get younger just because we haven't re-fetched it. */
  price_age_seconds_at_fetch: number;
}

let cache: CacheEntry | null = null;

interface FeedResult {
  rate: number;
  /** Unix seconds the SOURCE itself timestamps this price at, or null when
   *  the source exposes no such field (Astrolescent — see the doc block). */
  lastUpdatedAt: number | null;
}

async function fetchAstrolescent(): Promise<FeedResult | null> {
  try {
    const res = await fetch(ASTROLESCENT_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // The partner endpoint returns the price as `tokenPriceUSD` (alongside
    // tokenPriceXRD/marketCap). `usd` — what this read for — is not a field it
    // has ever returned, so the primary source silently yielded null on every
    // call and the route rode its CoinGecko fallback permanently.
    const rate = typeof data?.tokenPriceUSD === "number" ? data.tokenPriceUSD : null;
    // No price timestamp field exists on this endpoint — see the doc block.
    return rate && rate > 0 ? { rate, lastUpdatedAt: null } : null;
  } catch {
    return null;
  }
}

async function fetchCoinGecko(): Promise<FeedResult | null> {
  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rate = typeof data?.radix?.usd === "number" ? data.radix.usd : null;
    const lastUpdatedAt =
      typeof data?.radix?.last_updated_at === "number" ? data.radix.last_updated_at : null;
    return rate && rate > 0 ? { rate, lastUpdatedAt } : null;
  } catch {
    return null;
  }
}

/** Age (seconds) of a CoinGecko-sourced rate from its own `last_updated_at`.
 *  Fails open to 0 (looks fresh) when the field is absent — we just fetched
 *  it, and declaring an age we cannot measure would invent a number, the
 *  same trap `notePrimaryRate` avoids on a first sighting. */
function coinGeckoAgeSeconds(lastUpdatedAt: number | null, now: number): number {
  if (lastUpdatedAt === null) return 0;
  return Math.max(0, Math.floor(now / 1000) - lastUpdatedAt);
}

/** Age (seconds) of the currently-served Astrolescent rate: how long it has
 *  been unchanged, per `primaryObservation` — the proxy the doc block above
 *  explains (Astrolescent has no price timestamp of its own). */
function astroAgeSeconds(now: number): number {
  return Math.floor((now - (primaryObservation?.firstSeenAt ?? now)) / 1000);
}

export async function GET() {
  const now = Date.now();

  // Fresh cache — serve immediately. The price does not get younger just
  // because we're re-serving it from cache, so age_seconds adds the elapsed
  // wall-clock time on top of what it was AT fetch.
  if (cache && now - cache.fetched_at < CACHE_TTL_MS) {
    const ageSeconds =
      cache.price_age_seconds_at_fetch + Math.floor((now - cache.fetched_at) / 1000);
    return NextResponse.json({
      rate: cache.rate,
      inverse_rate: 1 / cache.rate,
      source: cache.source,
      fetched_at: new Date(cache.fetched_at).toISOString(),
      staleness_seconds: Math.floor((now - cache.fetched_at) / 1000),
      fallback_active: cache.source === "coingecko" || cache.primary_frozen,
      primary_frozen: cache.primary_frozen,
      stale: isStale(ageSeconds),
      age_seconds: ageSeconds,
    });
  }

  // Try primary. A rate coming back is necessary but NOT sufficient — a frozen
  // source answers 200 with yesterday's number, which is the whole failure this
  // route now guards. Ask whether it has moved before trusting it.
  const astroResult = await fetchAstrolescent();
  const astro = astroResult?.rate ?? null;
  const astroFrozen = astro !== null && notePrimaryRate(astro, now);

  if (astro !== null && !astroFrozen) {
    observe(ALERT_FROZEN, false, FROZEN_TITLE);
    observe(ALERT_STALE_SERVE, false, STALE_TITLE);
    observe(ALERT_FAIL_CLOSED, false, FAIL_CLOSED_TITLE);
    const ageSeconds = astroAgeSeconds(now);
    cache = {
      rate: astro,
      source: "astrolescent",
      fetched_at: now,
      primary_frozen: false,
      price_age_seconds_at_fetch: ageSeconds,
    };
    return NextResponse.json({
      rate: astro,
      inverse_rate: 1 / astro,
      source: "astrolescent",
      fetched_at: new Date(now).toISOString(),
      staleness_seconds: 0,
      fallback_active: false,
      primary_frozen: false,
      stale: isStale(ageSeconds),
      age_seconds: ageSeconds,
    });
  }

  if (astroFrozen) {
    console.error(
      "[quote/xrd-usd] Primary source frozen — rate unchanged past threshold, falling back",
      { rate: astro, frozenForMs: now - (primaryObservation?.firstSeenAt ?? now) },
    );
    observe(
      ALERT_FROZEN,
      true,
      FROZEN_TITLE,
      `Unchanged rate ${astro} for over ${Math.floor(PRIMARY_FROZEN_AFTER_MS / 60_000)} min. ` +
        `Usual cause: Radix halted, so the DEX pools it prices off are not trading. ` +
        `The feed answers 200 throughout, so nothing else would notice.`,
    );
  }

  // Fall back — reached when the primary FAILED or when it is frozen.
  const cgResult = await fetchCoinGecko();
  if (cgResult !== null) {
    observe(ALERT_STALE_SERVE, false, STALE_TITLE);
    observe(ALERT_FAIL_CLOSED, false, FAIL_CLOSED_TITLE);
    const cg = cgResult.rate;
    const ageSeconds = coinGeckoAgeSeconds(cgResult.lastUpdatedAt, now);
    cache = {
      rate: cg,
      source: "coingecko",
      fetched_at: now,
      primary_frozen: astroFrozen,
      price_age_seconds_at_fetch: ageSeconds,
    };
    return NextResponse.json({
      rate: cg,
      inverse_rate: 1 / cg,
      source: "coingecko",
      fetched_at: new Date(now).toISOString(),
      staleness_seconds: 0,
      fallback_active: true,
      primary_frozen: astroFrozen,
      stale: isStale(ageSeconds),
      age_seconds: ageSeconds,
    });
  }

  // Fallback is down too, and the primary is frozen rather than absent. Serve
  // the frozen number rather than nothing — a stale rate still beats a blank
  // price on every display surface — but say so, loudly, in the payload. The
  // old behaviour served exactly this number while reporting itself healthy,
  // and that, not the staleness, was the actual defect.
  if (astroFrozen && astro !== null) {
    const ageSeconds = astroAgeSeconds(now);
    cache = {
      rate: astro,
      source: "astrolescent",
      fetched_at: now,
      primary_frozen: true,
      price_age_seconds_at_fetch: ageSeconds,
    };
    return NextResponse.json({
      rate: astro,
      inverse_rate: 1 / astro,
      source: "astrolescent",
      fetched_at: new Date(now).toISOString(),
      staleness_seconds: 0,
      fallback_active: true,
      primary_frozen: true,
      stale: isStale(ageSeconds),
      age_seconds: ageSeconds,
    });
  }

  // Both feeds failed. If cache is within hard cap, serve stale with warning.
  if (cache && now - cache.fetched_at < MAX_STALENESS_MS) {
    const stalenessMs = now - cache.fetched_at;
    const ageSeconds = cache.price_age_seconds_at_fetch + Math.floor(stalenessMs / 1000);
    if (stalenessMs > OUTAGE_THRESHOLD_MS) {
      console.error(
        "[quote/xrd-usd] Both feeds down, serving stale cache",
        { stalenessMs, source: cache.source },
      );
      observe(
        ALERT_STALE_SERVE,
        true,
        STALE_TITLE,
        `Astrolescent + CoinGecko both down. Serving the cached rate, ` +
          `${Math.floor(stalenessMs / 60_000)} min old (source: ${cache.source}). ` +
          `Hard cap 15 min, then fail-closed.`,
      );
    }
    return NextResponse.json({
      rate: cache.rate,
      inverse_rate: 1 / cache.rate,
      source: cache.source,
      fetched_at: new Date(cache.fetched_at).toISOString(),
      staleness_seconds: Math.floor(stalenessMs / 1000),
      fallback_active: true,
      primary_frozen: cache.primary_frozen,
      stale: isStale(ageSeconds),
      age_seconds: ageSeconds,
    });
  }

  // No cache within hard cap. Fail closed.
  console.error("[quote/xrd-usd] Both feeds down, no usable cache — failing closed (503)");
  observe(
    ALERT_FAIL_CLOSED,
    true,
    FAIL_CLOSED_TITLE,
    `Astrolescent + CoinGecko both down and no cache within the 15 min hard cap. ` +
      `Route is 503 fail-closed: USD figures on the site are unavailable until a feed recovers (XRD amounts and on-chain actions are unaffected).`,
  );
  return NextResponse.json(
    {
      error: "price_feed_unavailable",
      message:
        "Both Astrolescent and CoinGecko are unavailable, so USD figures are not shown " +
        "until a price feed recovers. XRD amounts and on-chain actions are unaffected.",
    },
    { status: 503 },
  );
}
