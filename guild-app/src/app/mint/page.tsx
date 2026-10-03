"use client";
import { useState } from "react";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BadgeCard } from "@/components/badge-card";
import { TierProgression } from "@/components/tier-progression";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { GetXrdLinks } from "@/components/get-xrd-links";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadFailed } from "@/components/ui/load-failed";
import { useWallet } from "@/hooks/useWallet";
import { useXrdBalance } from "@/hooks/useXrdBalance";
import { ESCROW_CLAIM_BOND_XRD, MANAGER, TG_BOT_URL } from "@/lib/constants";
import { publicMintManifest } from "@/lib/manifests";
import { formatXrdUsd } from "@/lib/format-xrd-usd";
import { useXrdUsd } from "@/lib/use-xrd-usd";
import { FEE_HEADROOM_XRD } from "@/lib/marketplace";
import { XRD_NEEDED_LINE } from "@/lib/xrd-needed";

// Minting is free, but Radix charges a small network fee to commit the badge
// on-chain (public_mint runs well under 1 XRD). We hard-block at zero — the tx
// would fail on the fee — and soft-warn below this comfortable hint.
//
// The number itself moved to lib/marketplace.ts (FEE_HEADROOM_XRD) when the two
// escrow money pre-flights grew the same soft tier: there it is the headroom
// ABOVE the amount the tx locks, here the tx locks nothing so the cushion is
// the whole requirement. Same quantity, one definition, so the two cannot drift.
const LOW_XRD_THRESHOLD = FEE_HEADROOM_XRD;

// On-chain username charset — shown up front AND enforced live, so nobody
// discovers the rule via a post-click error (operator feedback, 2026-07-18
// wallet acceptance run: the poster's first mint died on this).
//
// The badge id is `guild_member_<username lower-cased>`, and a Radix string
// local id is `[A-Za-z0-9_]`, 1–64 bytes. The blueprint's own filter keeps '-',
// but `StringNonFungibleLocalId::new` then refuses it — mainnet preview
// 2026-09-24: "zzprobe-dash" → ContainsBadCharacter; a 52-char name (a 65-byte
// id) → TooLong. This regex allowed '-' until then, so a dash here signed a
// mint that failed. 51 = 64 − "guild_member_".length.
const USERNAME_MAX = 51;
const USERNAME_RE = /^[a-zA-Z0-9_]+$/;

/** Turn an RDT/wallet error into a human sentence instead of dumping raw JSON. */
function humanizeWalletError(err: unknown): string {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : JSON.stringify(err ?? "");
  const s = raw.toLowerCase();
  if (s.includes("reject") || s.includes("cancel"))
    return "Transaction cancelled in your wallet.";
  if (
    s.includes("insufficient") ||
    s.includes("not enough") ||
    s.includes("not_enough") ||
    (s.includes("fee") && s.includes("balance"))
  )
    return "Not enough XRD to cover the network fee. Add a little XRD to this account and try again.";
  return "Couldn't submit the transaction. Please try again — and if this account is new, make sure it holds a little XRD for the network fee.";
}

function MintContent() {
  const { account, connected, rdt, badge, badgeLoading, badgeError, refreshBadge } = useWallet();
  const { rate: usdRate } = useXrdUsd();
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState("");
  const [txId, setTxId] = useState("");
  const [error, setError] = useState("");
  const [minting, setMinting] = useState(false);

  // Check the connected account's XRD once it's known and still un-badged. A
  // zero-balance wallet can't pay the mint's network fee, so we guide the user
  // up front instead of letting the transaction fail with a raw error. Passing
  // null once a badge exists is what stops the fetch — the hook reads no
  // account at all rather than checking and discarding.
  //
  // ⚠️ This page carried its OWN balance fetch until 2026-09-16, and it was the
  // one the shared hook had been written to replace — useXrdBalance's docblock
  // said so, and was wrong for as long as this copy existed. The local copy
  // kept a bare `xrdBalance` / `balanceChecked` pair that was never tagged with
  // the account it was read for, which failed three ways, all toward a
  // DISABLED Mint button on data we already knew was stale:
  //   • wallet switch A → B: B rendered A's confirmed balance until its own
  //     fetch landed, so an empty A disabled Mint for a funded B;
  //   • disconnect → reconnect the SAME account: the pre-disconnect reading
  //     came back confirmed (the case found in #683's review);
  //   • recheckBalance() had no stale-response guard, so a slow re-check for A
  //     could land after switching to B.
  // useXrdBalance is keyed on the account, resets on every transition, and
  // guards superseded requests — see its own tests for each case.
  const {
    balance: xrdBalance,
    checked: balanceChecked,
    recheck: recheckBalance,
  } = useXrdBalance(account && !badge ? account : null);

  // Live charset check: hint + disabled button while invalid (trimmed, so
  // accidental surrounding whitespace alone doesn't flag).
  const usernameInvalid =
    username.trim().length > 0 && !USERNAME_RE.test(username.trim());

  // Only act on a CONFIRMED reading — null (unknown) never blocks the mint.
  const noXrd = balanceChecked && xrdBalance === 0;
  const lowXrd =
    balanceChecked &&
    xrdBalance !== null &&
    xrdBalance > 0 &&
    xrdBalance < LOW_XRD_THRESHOLD;

  async function handleMint() {
    if (!rdt || !account || !username.trim()) return;
    if (username.trim().length > USERNAME_MAX) { setError(`Username too long (max ${USERNAME_MAX} characters)`); return; }
    if (!USERNAME_RE.test(username.trim())) { setError("Username can only contain letters, numbers and _"); return; }
    setMinting(true); setStatus(""); setError(""); setTxId("");
    try {
      const manifest = publicMintManifest(MANAGER, username.trim(), account);
      const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 });
      if (result.isOk()) {
        setStatus("Badge minted!");
        setTxId(result.value.transactionIntentHash);
        setTimeout(() => refreshBadge(), 3000);
      } else { setError(humanizeWalletError(result.error)); }
    } catch (e: unknown) { setError(humanizeWalletError(e)); }
    setMinting(false);
  }

  if (!connected) {
    // The "Join the Guild" heading that stood here said the same thing as the
    // page's new h1 and the line below it — three restatements of "mint a
    // badge" in one viewport. The prompt is the only part that tells the reader
    // what to DO.
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground text-sm">
          Connect your wallet to mint your badge. Connecting is free and signs nothing that
          moves money.
        </p>
        {/* The same line /guide shows (lib/xrd-needed.ts): minting needs a little XRD for the
            fee, so say so before the wallet is connected, not after the button is disabled. */}
        <p className="text-muted-foreground text-xs mt-3 max-w-md mx-auto" data-testid="xrd-needed">
          {XRD_NEEDED_LINE}
        </p>
      </div>
    );
  }

  if (badgeLoading) {
    return <Card><CardContent className="p-5 space-y-4"><Skeleton className="h-5 w-32" /><Skeleton className="h-14 w-full" /><Skeleton className="h-1.5 w-full" /></CardContent></Card>;
  }

  if (badgeError) {
    // Gateway failed — badge state UNKNOWN. Offering the mint form here would
    // tell an existing badge-holder to re-mint (audit Theme C). Retry instead.
    return <LoadFailed what="your badge" onRetry={refreshBadge} />;
  }

  if (badge) {
    return (
      <div className="space-y-5">
        <BadgeCard badge={badge} />
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm font-semibold mb-2">Next Steps</p>
            {/* Rewritten 2026-09-23. Step 2 sent badge holders to a /governance
                bot command that does not exist (guild-public bot/index.js has no
                such handler), and step 3 promised that voting earns XP and levels
                up your tier — votes earn nothing that reaches Guild XP (only task
                settlement writes users.xp) and nothing moves the badge's tier. */}
            <div className="space-y-2 text-[13px] text-muted-foreground">
              <p>1. <Link href="/tasks" className="text-primary hover:underline">Browse the task board</Link> and claim a funded task — your badge is what the escrow checks, and claiming locks a bond of at least {ESCROW_CLAIM_BOND_XRD} XRD</p>
              <p>2. Deliver, then collect the reward with your own signed withdrawal — completed tasks build your XP and track record</p>
              <p>3. Optional: open the <a href={TG_BOT_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Telegram Bot</a> and type <code className="font-mono text-xs bg-muted px-1 rounded">/register</code> with your wallet address to check your badge and join the community votes</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="pt-5 space-y-4">
          <div>
            {/* htmlFor/id, aria-describedby and role="alert" added 2026-08-21. This
                is the mint flow's only text field and it had none of them: the
                label was unassociated, so a screen reader announced nothing
                identifying the input, and the validation message was conveyed in
                colour alone — aria-invalid said something was wrong without ever
                saying what. */}
            <label
              htmlFor="mint-username"
              className="block text-[11px] text-muted-foreground uppercase tracking-wider mb-1.5"
            >
              Username
            </label>
            <p id="mint-username-hint" className="text-xs text-muted-foreground mb-2">
              Your handle in the guild. Stored on-chain with your badge.
              Letters, numbers and <code className="font-mono">_</code> only — no spaces or dashes.
            </p>
            <Input
              id="mint-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. bigdevxrd"
              maxLength={USERNAME_MAX}
              className="font-mono"
              aria-invalid={usernameInvalid || undefined}
              aria-describedby={
                usernameInvalid ? "mint-username-hint mint-username-error" : "mint-username-hint"
              }
            />
            <div className="flex justify-between text-[11px] mt-1">
              <span
                id="mint-username-error"
                role={usernameInvalid ? "alert" : undefined}
                className={usernameInvalid ? "text-destructive" : "text-muted-foreground"}
              >
                {usernameInvalid
                  ? "Remove spaces/special characters — only letters, numbers and _"
                  : " "}
              </span>
              <span className="text-muted-foreground">{username.length}/{USERNAME_MAX} characters</span>
            </div>
          </div>
          {noXrd && (
            <Alert>
              <AlertDescription>
                <p className="font-medium text-foreground">This account has no XRD.</p>
                <p className="mt-1">
                  The badge is free, but Radix charges a small network fee (a
                  fraction of an XRD) to record it on-chain. Send a little XRD to
                  this account — 1 XRD is plenty — from an exchange or another
                  wallet, then re-check.
                </p>
                <GetXrdLinks />
                <Button variant="outline" size="sm" className="mt-2" onClick={recheckBalance}>
                  Re-check balance
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {lowXrd && (
            <Alert>
              <AlertDescription>
                This account holds {formatXrdUsd(xrdBalance ?? 0, usdRate, { xrdDecimals: 4 })}.
                Minting needs a small network fee — usually enough, but top up a
                little if the transaction fails.
              </AlertDescription>
            </Alert>
          )}
          <Button onClick={handleMint} disabled={minting || !username.trim() || usernameInvalid || noXrd} className="w-full" data-guide="mint-button">
            {minting ? "Minting..." : "Mint Guild Badge"}
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            The badge is free — you only pay the standard Radix network fee (a fraction of an XRD).
          </p>
          <p className="text-[11px] text-muted-foreground text-center" data-testid="xrd-needed">
            {XRD_NEEDED_LINE}
          </p>
          {(status || error) && (
            <Alert variant={error ? "destructive" : "default"}>
              <AlertDescription>
                {error || status}
                {txId && (
                  <a href={`https://dashboard.radixdlt.com/transaction/${txId}`} target="_blank" rel="noopener noreferrer" className="block mt-1 text-xs text-primary hover:underline">
                    View on Dashboard
                  </a>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">How It Works</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Your badge is an on-chain NFT that lives in your Radix Wallet. It is what lets you claim funded tasks. Claiming one locks a claim bond of 10% of the reward, at least {ESCROW_CLAIM_BOND_XRD} XRD today (an owner setting), which the escrow holds until the task settles.</p>
            <p>Completed tasks earn XP. Badge holders can also propose ideas and vote in the Telegram bot&apos;s optional community polls — one vote per Telegram account.</p>
            {/* Was "XP determines your tier and voting weight" until 2026-08-16,
                then "XP determines your tier" until 2026-09-23 — also false: the
                tier shown is the badge's own on-chain field (badge-card.tsx,
                tier-progression.tsx), which only the operator writes, and nothing
                computes a tier from XP. The live bot records one vote per
                Telegram account (votes PK = proposal_id + tg_id). */}
            <p>The tier on your badge is its own on-chain field, set only by the operator. It carries no permissions and no vote weight.</p>
          </div>
          <TierProgression />
        </CardContent>
      </Card>
    </div>
  );
}

export default function MintPage() {
  // ⚠️ /mint had no <h1> at all until 2026-08-21 — one of only two real routes
  // without one. It was invisible by eye because MintContent returns a
  // DIFFERENT tree per state (loading / has-badge / no-badge / gateway-failed),
  // and each looked fine on its own. Hoisting the title out of those branches
  // is what makes it one title rather than four maybes.
  return (
    <AppShell>
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Mint your Guild badge</h1>
        <MintContent />
      </div>
    </AppShell>
  );
}
