import Link from "next/link";
import { Bitcoin, CreditCard, Coins } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BtcGiftCard } from "@/components/gift/btc-gift-card";
import { XrdGiftCard } from "@/components/gift/xrd-gift-card";
import { giftDestination } from "@/lib/gift";
import { cn } from "@/lib/utils";

/**
 * The gift rails, shared by /gift and /bigdev so the two can never drift.
 *
 * Callers supply their own framing, but NOT the disclosure — GiftDisclosure
 * ships with the rails on purpose. "A gift buys nothing" has to appear
 * wherever gifts are asked for, and a caller that forgot it would be the bug.
 *
 * Each rail is a plain `&&` on its own destination: unset or invalid resolves
 * to null in lib/gift.ts, so an unconfigured rail renders nothing and there is
 * no placeholder to leak. Safe to embed on a page that does NOT itself 404
 * when gifts are dark (i.e. /bigdev, where the bio is the point) — the rails
 * simply disappear. Use isGiftPageLive() to decide whether to show a heading.
 */
export function GiftRails() {
  const xrd = giftDestination("xrd");
  const btc = giftDestination("btc");
  const stripe = giftDestination("stripe");
  const paypal = giftDestination("paypal");

  return (
    <>
      {xrd && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-muted-foreground">
              <Coins className="h-4 w-4" />
              XRD
            </CardTitle>
          </CardHeader>
          <CardContent>
            <XrdGiftCard address={xrd} />
          </CardContent>
        </Card>
      )}

      {btc && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-muted-foreground">
              <Bitcoin className="h-4 w-4" />
              Bitcoin
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BtcGiftCard address={btc} />
          </CardContent>
        </Card>
      )}

      {(stripe || paypal) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-muted-foreground">
              <CreditCard className="h-4 w-4" />
              Card or PayPal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {/* buttonVariants on real anchors, NOT <Button render={<a/>}>:
                  Base UI's Button stamps role="button" onto whatever it renders,
                  which would announce these navigating links as buttons.
                  Styling from the variant, semantics from the element. */}
              {stripe && (
                <a
                  href={stripe}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants(), "no-underline")}
                >
                  Gift by card
                </a>
              )}
              {paypal && (
                <a
                  href={paypal}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ variant: "outline" }), "no-underline")}
                >
                  Gift via PayPal
                </a>
              )}
            </div>
            {/* Said plainly because the crypto rails above behave differently:
                these hand the donor off to a third party who sees their name
                and card, takes a cut, and can reverse the payment later. */}
            <p className="text-xs text-muted-foreground">
              These open {stripe && paypal ? "Stripe or PayPal" : stripe ? "Stripe" : "PayPal"} in a
              new tab. Your card details go to them, never to this site — the guild never sees or
              stores them. They charge a processing fee, so a little less arrives than you send.
            </p>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        Gifts go to bigdev, who builds and runs the guild — there is no DAO treasury yet, and none
        is scheduled. If that ever changes, this page will say so.
      </p>
    </>
  );
}

/**
 * The honest-copy disclosure. Rendered above the rails on every surface that
 * asks for a gift — this is the claim the page exists to NOT overstate.
 */
export function GiftDisclosure() {
  return (
    <Card>
      <CardContent className="space-y-3 pb-5 pt-5 text-sm leading-relaxed">
        <p>
          {/* The {" "} after </strong> is load-bearing, NOT formatting. SWC
              drops the leading whitespace of any JSX text node that contains
              an HTML entity, and this node has &apos; below — so a plain
              `</strong> No token` ships as "nothing.No token". Confirmed by
              A/B production build; /docs and /guide use the same
              pattern safely only because their nodes have no entity.
              Pinned end-to-end by tests/e2e/gift.spec.ts (vitest compiles
              JSX with esbuild and cannot reproduce it). */}
          <strong>A gift buys nothing.</strong>{" "}
          No token, no equity, no priority in the queue, no vote, no refund, and no claim on
          anything the guild does later. It is a thank-you, not a purchase. If you want work
          done, don&apos;t send a gift —{" "}
          <Link href="/tasks/create" className="text-primary hover:underline">
            post a task
          </Link>{" "}
          instead, where the money sits in escrow and buys something specific.
        </p>
        <p className="text-muted-foreground">
          {/* Was "a poster-side settlement fee, capped on-ledger at 2.5%" until
              2026-08-16 — no blueprint has a percentage cap; the instrument is
              a flat XRD royalty on create_task (see /docs Revenue Model). */}
          Fees are still the plan, not gifts forever: a poster-side royalty when a task is
          funded — a flat XRD amount per funded post, 0 during beta, never a percentage of the
          reward. Workers pay 0%. Costs and revenue to date are itemised under{" "}
          <Link href="/docs#transparency" className="text-primary hover:underline">
            Costs &amp; Transparency
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}
