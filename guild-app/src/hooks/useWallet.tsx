"use client";
import { useEffect, useRef, useState, useCallback, createContext, useContext, useMemo } from "react";
import { RadixDappToolkit, RadixNetwork, DataRequestBuilder } from "@radixdlt/radix-dapp-toolkit";
import { apiFetch } from "@/lib/api-fetch";
import {
  type SessionOutcome,
  SESSION_OK,
  sessionFailure,
  explainSignInRequestError,
  explainSignInThrow,
  explainVerifyRefusal,
} from "@/lib/session-outcome";
import { DAPP_DEF, BADGE_NFT } from "@/lib/constants";
import { loadUserBadgeResult } from "@/lib/gateway";
import type { BadgeInfo } from "@/lib/types";

const CACHE_KEY = "guild-badge-cache";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * e2e seam. A Playwright addInitScript (tests/e2e/helpers.ts → injectWalletMock)
 * may install a mock RadixDappToolkit factory on `window` before any app script
 * runs; the mock completes ROLA sign-in and records the manifests the app sends
 * so the browser money-path specs run without a real wallet (the recorded
 * manifests are replayed against tests/support/mock-ledger.ts). In every
 * non-e2e build the global is never set — nothing in the app writes it — so this
 * branch is dead code and the real toolkit is always used.
 */
declare global {
  interface Window {
    __GUILD_E2E_RDT__?: () => RadixDappToolkit;
  }
}

function createDappToolkit(): RadixDappToolkit {
  if (typeof window !== "undefined" && window.__GUILD_E2E_RDT__) {
    return window.__GUILD_E2E_RDT__();
  }
  return RadixDappToolkit({
    dAppDefinitionAddress: DAPP_DEF,
    networkId: RadixNetwork.Mainnet,
    applicationName: "Radix Guild",
    applicationVersion: "1.0.0",
  });
}

/**
 * SignedChallenge — matches the shape ROLA's server-side verifier expects.
 * Sent as the `proof` field on POST /api/v1/auth/verify.
 */
export type SignedChallenge = {
  address: string;
  type: "account";
  challenge: string;
  proof: {
    publicKey: string;
    signature: string;
    curve: "curve25519" | "secp256k1";
  };
};

/**
 * Minimal authenticated-user shape. The /me and /verify endpoints return the
 * full DB user; consumers cast for extra fields as needed. Kept deliberately
 * small so the session stays "wallet identity + (future) roles", NOT "this
 * wallet IS the task poster" — that keeps DAO-commissioner support (a role or
 * badge granting authority) additive rather than a rewrite.
 *
 * `xp` IS declared (not left to a cast): it is `users.xp`, the column task
 * settlement actually credits (awardTaskCompletion in
 * src/db/queries/users.ts, called from escrow-confirm.ts on a paid release),
 * and both /me and /verify already return it on the full row. It is the
 * number the header pill and profile card show — see app-shell.tsx. Do NOT
 * confuse it with a connected wallet's `badge.xp` (BadgeInfo, above): that is
 * the guild_member NFT's OWN xp field, written only by the Telegram bot's XP
 * queue (votes/polls/dice, scripts/xp-batch-signer.js) — a different number
 * that a settled task never touches (catalogue P4-20, task 88, 2026-09-15).
 */
export interface AuthUser {
  id: string;
  address?: string;
  xp?: number;
}

/**
 * Decide what happens to the current session when the wallet's shared-account
 * set changes. Pure + exported so the account-switch logic is unit-tested
 * without RDT (tests/unit/use-wallet-session-guard.test.tsx).
 *
 *   "drop" → clear the session (re-auth required); "keep" → leave it intact.
 *
 *   - no shared accounts          → drop (wallet disconnected).
 *   - no session                  → keep (nothing to drop).
 *   - session account not shared  → drop (it was removed — a tx it signs must
 *                                   never be confirmed under a still-shared
 *                                   account's authority; smoke 2026-06-11).
 *   - genuine wallet-side switch  → drop: the PRIMARY account (shared[0])
 *                                   changed to a new value AND it isn't the
 *                                   session's account. Display follows the new
 *                                   primary; the user re-signs on demand.
 *   - otherwise                   → keep.
 *
 * The switch case keys off the PRIMARY CHANGING (a delta vs the previous
 * primary), never "session != accounts[0]". Our ROLA sign-in is a one-time
 * request that does not reorder the persistent shared list, so proving a
 * non-first account never moves the primary and never drops the session — an
 * accounts[0]-equality check there is exactly what logout-looped multi-account
 * wallets (#151).
 */
export function decideSession(
  shared: string[],
  sessionId: string | null,
  prevPrimary: string | null,
): "drop" | "keep" {
  if (shared.length === 0) return "drop";
  if (!sessionId) return "keep";
  if (!shared.includes(sessionId)) return "drop";
  const newPrimary = shared[0];
  if (prevPrimary !== null && newPrimary !== prevPrimary && sessionId !== newPrimary) {
    return "drop";
  }
  return "keep";
}

interface WalletState {
  account: string | null;
  connected: boolean;
  rdt: RadixDappToolkit | null;
  badge: BadgeInfo | null;
  badgeLoading: boolean;
  /**
   * True when the last badge lookup FAILED at the Gateway (network/HTTP/shape)
   * — badge state is unknowable, NOT confirmed-badgeless. Mint nudges must
   * branch on this before treating `badge === null` as "no badge" (a gateway
   * blip must never tell a badge-holder to re-mint).
   */
  badgeError: boolean;
  refreshBadge: () => Promise<void>;
  signChallenge: () => Promise<SignedChallenge | null>;
  /** True once a guild_session exists (hydrated from /me or established via signIn). */
  authed: boolean;
  /** The authenticated session user, or null when there's no valid session. */
  user: AuthUser | null;
  /**
   * True when the session's account is NOT among the accounts the wallet
   * currently shares (user ids ARE Radix addresses). Tx buttons must
   * hard-block on this: a tx sent by one account must never be confirmed
   * under another's session (the root cause of every incident in the
   * 2026-06-11 mainnet smoke). ANY currently-shared account is a legitimate
   * session identity — the wallet may share several, and the user picks which
   * one signs the ROLA proof (comparing against accounts[0] alone is what
   * logout-looped multi-account wallets after #151). Normally self-heals —
   * the provider drops a session whose account stops being shared — so it
   * only persists when the sign-in proof was given for an unshared account.
   */
  sessionMismatch: boolean;
  /** Run the ROLA sign-in: wallet signature → POST /verify → set the session. False on cancel/failure; never throws. */
  signIn: () => Promise<boolean>;
  /** Ensure a session before a protected DB write — no-op if already authed, else signs in. Never throws. */
  ensureSession: () => Promise<boolean>;
  /**
   * The same sign-in, reported: `ok: false` names its cause (the wallet's own
   * code, /verify's refusal, a network drop, an unshared account) in a
   * sentence a button can show. Never throws.
   */
  signInDetailed: () => Promise<SessionOutcome>;
  /** The same gate as ensureSession, reported the same way. Never throws. */
  ensureSessionDetailed: () => Promise<SessionOutcome>;
  /** Clear the server session cookie and local auth state. */
  signOut: () => Promise<void>;
}

const WalletContext = createContext<WalletState>({
  account: null, connected: false, rdt: null, badge: null, badgeLoading: false,
  badgeError: false,
  refreshBadge: async () => {},
  signChallenge: async () => null,
  authed: false, user: null, sessionMismatch: false,
  signIn: async () => false,
  ensureSession: async () => false,
  signInDetailed: async () => sessionFailure("no-wallet"),
  ensureSessionDetailed: async () => sessionFailure("no-wallet"),
  signOut: async () => {},
});

export function useWallet() {
  return useContext(WalletContext);
}

async function fetchChallenge(): Promise<string> {
  const res = await apiFetch("/api/v1/auth/challenge");
  const data = await res.json();
  if (!data?.ok || !data.data?.challenge) {
    throw new Error("Failed to fetch ROLA challenge");
  }
  return data.data.challenge;
}

function getCachedBadge(addr: string): BadgeInfo | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { address, badge, timestamp } = JSON.parse(raw);
    if (address !== addr || Date.now() - timestamp > CACHE_TTL) return null;
    return badge;
  } catch { return null; }
}

function setCachedBadge(addr: string, badge: BadgeInfo | null) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ address: addr, badge, timestamp: Date.now() }));
  } catch { /* sessionStorage unavailable */ }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [badge, setBadge] = useState<BadgeInfo | null>(null);
  const [badgeLoading, setBadgeLoading] = useState(false);
  const [badgeError, setBadgeError] = useState(false);
  const [rdt, setRdt] = useState<RadixDappToolkit | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const accountRef = useRef<string | null>(null);
  // ALL accounts the wallet currently shares with the dApp (walletData$
  // order). A session may legitimately belong to ANY of them — guards must
  // check membership here, never equality with accounts[0]: the wallet lets
  // the user sign the ROLA proof with any shared account, so accounts[0]
  // equality logout-looped multi-account wallets (post-#151 smoke).
  const sharedAccountsRef = useRef<string[]>([]);
  const [sharedAccounts, setSharedAccounts] = useState<string[]>([]);
  // The wallet's previous PRIMARY account (shared[0]) across walletData$ emits.
  // A change here is how we tell a real wallet-side account switch apart from
  // the user merely proving a non-first account in our ROLA prompt — see
  // decideSession().
  const prevPrimaryRef = useRef<string | null>(null);
  // Mirror of `user` for the walletData$ subscription (set up once — it must
  // not close over state) and for ensureSession's freshness check.
  const userRef = useRef<AuthUser | null>(null);

  const doLoadBadge = useCallback(async (addr: string, skipCache = false) => {
    // Check cache first
    if (!skipCache) {
      const cached = getCachedBadge(addr);
      if (cached) { setBadge(cached); setBadgeError(false); return; }
    }

    setBadgeLoading(true);
    setBadgeError(false);
    // Discriminated lookup: a Gateway failure is "unknowable", never "no
    // badge" — surfaced as badgeError so mint nudges don't fire on a blip.
    const result = await loadUserBadgeResult(addr, BADGE_NFT);
    if (result.ok) {
      // The active account can change while the gateway call is in flight
      // (sign-in adopts whichever shared account the user proved) — cache the
      // result, but don't clobber the now-active account's badge.
      if (accountRef.current === addr) setBadge(result.badge);
      setCachedBadge(addr, result.badge);
    } else {
      // Don't cache failures, don't clobber a previously shown badge.
      if (accountRef.current === addr) setBadgeError(true);
    }
    setBadgeLoading(false);
  }, []);

  // Re-derive the exposed `account` from the shared list + session: the
  // session's account whenever the wallet shares it (so display, badge
  // loading, and tx flows follow the proved identity even when it isn't
  // accounts[0]), else the first shared account. Loads the badge on change.
  const publishAccount = useCallback(() => {
    const shared = sharedAccountsRef.current;
    const u = userRef.current;
    const addr = u && shared.includes(u.id) ? u.id : (shared[0] ?? null);
    const prev = accountRef.current;
    accountRef.current = addr;
    setAccount(addr);
    if (addr && addr !== prev) doLoadBadge(addr);
    return addr;
  }, [doLoadBadge]);

  const publishUser = useCallback((u: AuthUser | null) => {
    userRef.current = u;
    setUser(u);
    // The session drives which shared account is "active" — adopt it right
    // away (e.g. after a verify for a non-first shared account, when no
    // walletData$ emit fires to do it for us).
    publishAccount();
  }, [publishAccount]);

  const refreshBadge = useCallback(async () => {
    if (accountRef.current) await doLoadBadge(accountRef.current, true); // skip cache on refresh
  }, [doLoadBadge]);

  // Silently hydrate session state from /me — no wallet signature. Lets a
  // returning user with a valid guild_session cookie be "signed in" without
  // re-signing, keeping on-chain browsing frictionless. While the wallet
  // shares accounts, a session for an account it does NOT currently share is
  // dropped instead of adopted: user ids are Radix addresses, and a stale
  // cookie must never authorize confirms for txs sent by an account the
  // wallet can't prove. ANY currently-shared account is legitimate — the
  // user may have proved a non-first one (membership, not accounts[0]).
  const hydrateSession = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await apiFetch("/api/v1/auth/me");
      if (!res.ok) { publishUser(null); return null; }
      const body = await res.json().catch(() => ({}));
      const u = body?.ok ? (body.data.user as AuthUser) : null;
      // Read the ref AFTER the await — fresher than a captured argument if
      // the wallet's share list changed while /me was in flight.
      const shared = sharedAccountsRef.current;
      if (u && shared.length > 0 && !shared.includes(u.id)) {
        apiFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
        publishUser(null);
        return null;
      }
      publishUser(u);
      return u;
    } catch {
      publishUser(null);
      return null;
    }
  }, [publishUser]);

  useEffect(() => {
    const instance = createDappToolkit();
    // ROLA: register the challenge generator once. RDT calls this whenever a
    // proof-bearing request runs (e.g. accounts().withProof()).
    instance.walletApi.provideChallengeGenerator(fetchChallenge);
    instance.walletApi.setRequestData(DataRequestBuilder.accounts().atLeast(1));
    // walletData$ is a BehaviorSubject — it fires synchronously on subscribe.
    // Publishing `rdt` inside this callback (rather than directly in the effect
    // body) satisfies react-hooks/set-state-in-effect; subsequent emits are
    // no-op setState calls (same instance reference, React bails out).
    instance.walletApi.walletData$.subscribe((data) => {
      setRdt(instance);
      const accts = data?.accounts ?? [];
      const shared = accts.map((a) => a.address);
      sharedAccountsRef.current = shared;
      setSharedAccounts(shared);
      const u = userRef.current;
      // Decide the session's fate against the PREVIOUS primary, then record the
      // new primary for the next emit's delta check.
      const action = decideSession(shared, u?.id ?? null, prevPrimaryRef.current);
      prevPrimaryRef.current = shared[0] ?? null;
      if (shared.length > 0) {
        if (u && action === "drop") {
          // Either the session's account is no longer shared, or the wallet's
          // active (primary) account was switched to a different one. Clear the
          // session so a tx is never confirmed under the wrong account; `account`
          // re-derives to the new primary and the user re-signs on demand
          // (ensureSession prompts at the next write). See decideSession().
          apiFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
          publishUser(null); // re-derives `account` from the new list
        } else {
          publishAccount();
          if (!u) {
            // Pick up an existing session cookie; no signature prompt. Drops
            // the cookie instead if its account isn't shared anymore.
            hydrateSession();
          }
        }
      } else {
        setBadge(null);
        publishUser(null); // re-derives `account` → null
        sessionStorage.removeItem(CACHE_KEY);
        // Wallet disconnected — drop the server session too so it can't linger.
        apiFetch("/api/v1/auth/logout", { method: "POST" }).catch(() => {});
      }
    });
    return () => instance.destroy();
  }, [hydrateSession, publishAccount, publishUser]);

  /**
   * Ask the wallet for a one-time account proof over a server-issued ROLA
   * challenge. Reported, never thrown: the toolkit's own error code (the
   * request not delivered, cancelled, declined, the challenge not fetched)
   * comes back as a SessionFailure a button can show.
   */
  const requestProof = useCallback(async (): Promise<{ ok: true; proof: SignedChallenge } | Extract<SessionOutcome, { ok: false }>> => {
    if (!rdt) return sessionFailure("no-wallet");
    let result: Awaited<ReturnType<RadixDappToolkit["walletApi"]["sendOneTimeRequest"]>>;
    try {
      result = await rdt.walletApi.sendOneTimeRequest(
        DataRequestBuilder.accounts().exactly(1).withProof(),
      );
    } catch (e) {
      // The toolkit rejects (rather than resolving err) when its challenge
      // generator throws — fetchChallenge above, on a dead network.
      console.error("signChallenge: request threw", e);
      return explainSignInThrow(e);
    }
    if (result.isErr()) {
      console.error("signChallenge: wallet rejected", result.error);
      return explainSignInRequestError(result.error);
    }
    // RDT 2.x returns proofs at the top level of WalletData. For an account
    // request with .withProof(), proofs[0].type === "account" and its shape
    // already matches @radixdlt/rola's SignedChallenge.
    const proof = result.value.proofs?.[0];
    if (!proof || proof.type !== "account") {
      return sessionFailure("wallet-error", "the wallet's answer carried no account proof");
    }
    return {
      ok: true,
      proof: {
        address: proof.address,
        type: "account",
        challenge: proof.challenge,
        proof: proof.proof,
      },
    };
  }, [rdt]);

  /**
   * Request a fresh signed proof from the connected wallet. The wallet
   * prompts the user, signs a server-issued nonce with the account key,
   * and returns a SignedChallenge ready to ship as the `proof` field on
   * a ROLA-protected POST. Returns null on user-cancel or error (the reason
   * is requestProof's; this shape is kept for callers that only need the proof).
   */
  const signChallenge = useCallback(async (): Promise<SignedChallenge | null> => {
    const r = await requestProof();
    return r.ok ? r.proof : null;
  }, [requestProof]);

  /**
   * Establish a session: prompt a one-time wallet signature, POST the proof to
   * /verify, and store the returned user. This is the single ROLA sign-in
   * path. Never throws: a failure says which step did not complete and why.
   */
  const signInDetailed = useCallback(async (): Promise<SessionOutcome> => {
    const r = await requestProof();
    if (!r.ok) return r;
    let res: Response;
    try {
      res = await apiFetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_challenge: r.proof }),
      });
    } catch (e) {
      // Until 2026-10-06 this fetch had no catch: a network drop here rejected
      // ensureSession() and left every escrow button spinning with no text.
      console.error("signIn: verify unreachable", e);
      return sessionFailure("unreachable", e instanceof Error ? e.message : String(e));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.ok) {
      console.error("signIn: verify failed", body?.error);
      return explainVerifyRefusal(res.status, body?.error);
    }
    publishUser(body.data.user as AuthUser);
    return SESSION_OK;
  }, [requestProof, publishUser]);

  /** signInDetailed as a boolean, for callers that only branch on it. */
  const signIn = useCallback(async (): Promise<boolean> => (await signInDetailed()).ok, [signInDetailed]);

  /**
   * Gate a protected DB write. No-op (ok) if already authed FOR AN ACCOUNT THE
   * WALLET SHARES; otherwise re-checks the server once (a cookie may exist
   * before state hydrated — dropped if its account isn't shared), and only
   * then prompts a signature. Call this right before a withAuth'd request.
   * Never throws: the escrow buttons show its failure sentence.
   */
  const ensureSessionDetailed = useCallback(async (): Promise<SessionOutcome> => {
    const shared = sharedAccountsRef.current;
    const u = userRef.current;
    if (u && (shared.length === 0 || shared.includes(u.id))) return SESSION_OK;
    if (await hydrateSession()) return SESSION_OK;
    const signed = await signInDetailed();
    if (!signed.ok) return signed;
    // The wallet lets the user sign the proof with ANY of its accounts —
    // every one it currently shares is a legitimate identity (verify just
    // made the session, and `account`, follow it). But a proof for an
    // account the wallet does NOT share must not green-light this tx flow
    // (the caller would send the tx as a shared account and confirm it as
    // the other: the smoke's wrong-account incident). The mismatch banner
    // takes over from here. Re-read the ref — the list may have changed
    // while the wallet prompt was open.
    const sharedNow = sharedAccountsRef.current;
    const fresh = userRef.current;
    if (sharedNow.length === 0 || (!!fresh && sharedNow.includes(fresh.id))) return SESSION_OK;
    return sessionFailure(
      "account-mismatch",
      fresh ? `signed in as ${fresh.id}; the wallet shares ${sharedNow.join(", ")}` : "no session user after verify",
    );
  }, [hydrateSession, signInDetailed]);

  /** ensureSessionDetailed as a boolean, for callers that only branch on it. */
  const ensureSession = useCallback(async (): Promise<boolean> => (await ensureSessionDetailed()).ok, [ensureSessionDetailed]);

  /** Clear the server session cookie and local auth state. */
  const signOut = useCallback(async (): Promise<void> => {
    try { await apiFetch("/api/v1/auth/logout", { method: "POST" }); } catch { /* best-effort */ }
    publishUser(null);
  }, [publishUser]);

  // user ids ARE Radix addresses — see sessionMismatch's doc on WalletState.
  // Membership in the FULL shared list, not equality with one account: the
  // session legitimately follows whichever shared account signed the proof.
  const sessionMismatch = !!(user && sharedAccounts.length > 0 && !sharedAccounts.includes(user.id));

  const value = useMemo<WalletState>(() => ({
    account, connected: !!account, rdt, badge, badgeLoading, badgeError,
    refreshBadge, signChallenge,
    authed: !!user, user, sessionMismatch, signIn, ensureSession, signInDetailed, ensureSessionDetailed, signOut,
  }), [account, rdt, badge, badgeLoading, badgeError, refreshBadge, signChallenge, user, sessionMismatch, signIn, ensureSession, signInDetailed, ensureSessionDetailed, signOut]);

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}
