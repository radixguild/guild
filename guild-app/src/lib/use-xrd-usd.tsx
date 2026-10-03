"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * use-xrd-usd — client-side XRD/USD rate provider + hook.
 *
 * Polls GET /api/v1/quote/xrd-usd on mount and every 60s, exposing the
 * latest rate to the whole tree. FAILS OPEN on every error path: any
 * non-200, network fault, or parse error resets to { rate: null } so
 * consumers fall back to the XRD-only label (see formatXrdUsd) instead
 * of breaking. Reading the hook with no provider mounted returns the
 * same null state, so components never require the provider to render.
 *
 * P3 "USD dual-label" foundation.
 *
 * ── `stale` (fixed 2026-09-03, R1) ──────────────────────────────────────────
 * This used to derive `stale` from the route's `staleness_seconds` — how long
 * ago WE polled — compared against a 5-minute bar. Since the route caches for
 * only 60s, that bar was essentially always false, INCLUDING while the route's
 * own `primary_frozen` flag said the underlying Astrolescent price had been
 * unchanged since before the 2026-08-31 halt: exactly the "reports itself
 * fresh, measures our fetch time not the price's age" bug board note M5 calls
 * out. The route now computes `stale`/`age_seconds` itself from the PRICE's
 * own age (its doc block explains how, per source) — this hook just reads
 * that field rather than re-deriving a weaker one from the wrong clock.
 */

interface XrdUsdValue {
  rate: number | null;
  stale: boolean;
  /** Age (seconds) of the underlying price, straight from the route's
   *  `age_seconds` — null when there is no usable quote at all. */
  ageSeconds: number | null;
  source: string | null;
}

const QUOTE_URL = "/api/v1/quote/xrd-usd";
const POLL_MS = 60_000;

const EMPTY: XrdUsdValue = { rate: null, stale: false, ageSeconds: null, source: null };

const XrdUsdContext = createContext<XrdUsdValue>(EMPTY);

export function XrdUsdProvider({ children }: { children: React.ReactNode }) {
  const [value, setValue] = useState<XrdUsdValue>(EMPTY);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const load = async () => {
      try {
        const res = await fetch(QUOTE_URL, { cache: "no-store" });
        if (!res.ok) {
          // 503 (fail-closed feed outage) and every other non-200 → fail open.
          if (mountedRef.current) setValue(EMPTY);
          return;
        }
        const body = await res.json();
        const rate = typeof body?.rate === "number" ? body.rate : null;
        if (rate === null || !Number.isFinite(rate)) {
          if (mountedRef.current) setValue(EMPTY);
          return;
        }
        const source = typeof body?.source === "string" ? body.source : null;
        const ageSeconds = typeof body?.age_seconds === "number" ? body.age_seconds : null;
        // `stale` is authoritative from the route (price-age based). Fall
        // back to deriving it from age_seconds only if an older/odd response
        // ever omits the field — never silently treat "unknown" as "fresh".
        const stale =
          typeof body?.stale === "boolean" ? body.stale : (ageSeconds ?? 0) >= 30 * 60;
        if (mountedRef.current) {
          setValue({
            rate,
            stale,
            ageSeconds,
            source,
          });
        }
      } catch (err) {
        // Network/parse failure → fail open.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[use-xrd-usd] quote fetch failed, failing open", err);
        }
        if (mountedRef.current) setValue(EMPTY);
      }
    };

    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, []);

  return (
    <XrdUsdContext.Provider value={value}>{children}</XrdUsdContext.Provider>
  );
}

export function useXrdUsd(): XrdUsdValue {
  return useContext(XrdUsdContext);
}
