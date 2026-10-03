"use client";

import { useCallback, useRef, useState } from "react";
import { CheckCircle, Wallet } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { giftXrdManifest } from "@/lib/manifests";
// The codebase's wallet-error humanizer. It lives under escrow-utils for
// historical reasons but is not escrow-specific: its escrow branches simply do
// not match a plain transfer, and the branch that DOES matter here — the donor
// dismissing the wallet prompt — is the one a gift hits most.
import { humanizeTxError } from "@/lib/escrow-utils";
import { XRD_PRESETS, formatXrdAmountForDisplay, isSendableXrdAmount } from "@/lib/gift";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/copy-button";
import { GiftQr } from "./gift-qr";

/**
 * XRD gift rail. Two paths on purpose, because a cold visitor is the point:
 *
 *   - Connected wallet → pick an amount, sign, done.
 *   - No wallet, or a wallet this dApp cannot reach → the address, a QR, and a
 *     copy button. Radix has no standard payment-URI scheme (unlike BIP-21),
 *     so the QR is the bare account address and the donor sets the amount in
 *     their own wallet. Nothing here pretends otherwise.
 *
 * The manual path renders ALWAYS, connected or not: it is the fallback when
 * signing fails, and it is what a phone camera can act on.
 *
 * `address` is already validated by gift.ts — this component never sees an
 * unchecked destination and never supplies a default one.
 */
export function XrdGiftCard({ address }: { address: string }) {
  const { account, rdt } = useWallet();
  const [selected, setSelected] = useState<string>(XRD_PRESETS[1]);
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const [txId, setTxId] = useState("");
  const [loading, setLoading] = useState(false);
  // Synchronous re-entry guard, mirroring escrow-actions' E3 guard: disabled=
  // {loading} alone leaves a batching window where a second click sends a
  // second transaction. For a gift that means charging someone twice.
  const inFlight = useRef(false);

  const amount = custom.trim() || selected;
  // "Valid" means "the manifest can build AND send this" — see gift.ts. A looser
  // check here would enable the button on an amount that throws on click.
  const amountValid = isSendableXrdAmount(amount);
  // bigdev viewing their own page while connected to the gift account: the
  // manifest builder rejects a self-send, so say why instead of offering a
  // button that throws.
  const isSelfGift = account !== null && account === address;
  const canSign = Boolean(account && rdt) && !isSelfGift;

  const send = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const manifest = giftXrdManifest(account!, address, Number(amount));
      const result = await rdt!.walletApi.sendTransaction({
        transactionManifest: manifest,
        version: 1,
      });
      if (result.isOk()) setTxId(result.value.transactionIntentHash);
      else setError(JSON.stringify(result.error));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [account, address, amount, rdt]);

  const humanized = error ? humanizeTxError(error) : null;

  return (
    <div className="space-y-4">
      {txId ? (
        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            Thank you — your gift is on its way.{" "}
            <a
              href={`https://dashboard.radixdlt.com/transaction/${txId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              View transaction
            </a>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {XRD_PRESETS.map((p) => (
              <Button
                key={p}
                type="button"
                variant={!custom.trim() && selected === p ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setSelected(p);
                  setCustom("");
                }}
              >
                {Number(p).toLocaleString("en-US")} XRD
              </Button>
            ))}
            <Input
              inputMode="decimal"
              placeholder="Other"
              aria-label="Custom XRD amount"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="h-8 w-28"
            />
          </div>

          {canSign ? (
            <div className="space-y-2">
              <Button
                onClick={send}
                disabled={loading || !amountValid}
                className="w-full sm:w-auto"
              >
                <Wallet className="mr-2 h-4 w-4" />
                {loading
                  ? "Check your wallet…"
                  : `Send ${amountValid ? formatXrdAmountForDisplay(amount) : "—"} XRD`}
              </Button>
              {!amountValid && custom.trim() !== "" && (
                <p className="text-xs text-destructive">Enter an amount greater than 0.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {isSelfGift
                ? "This is the gift account — connect a different account to send."
                : "Connect your Radix Wallet to send in one click, or use the address below."}
            </p>
          )}

          {humanized && (
            <div className="space-y-1 text-xs" role="alert">
              <p className="text-destructive">{humanized.summary}</p>
              {humanized.detail && (
                <details className="text-muted-foreground">
                  <summary className="cursor-pointer select-none">Error details</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[10px]">
                    {humanized.detail}
                  </pre>
                </details>
              )}
            </div>
          )}
        </>
      )}

      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
        <GiftQr value={address} label="Radix account address for XRD gifts" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted-foreground">
            Or send any amount to this Radix account. Scan the code, or copy the address —
            set the amount in your own wallet.
          </p>
          {/* The address is rendered in full, not truncated: it is the fallback
              when the clipboard is unavailable, and a donor must be able to
              check what they are sending to against what they pasted. */}
          <code className="block break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-primary">
            {address}
          </code>
          <CopyButton value={address} label="Copy address" />
        </div>
      </div>
    </div>
  );
}
