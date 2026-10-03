import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { GiftDisclosure, GiftRails } from "@/components/gift/gift-rails";
import { isGiftPageLive } from "@/lib/gift";
import { TG_BOT_URL } from "@/lib/constants";
import { withPageOg } from "@/lib/page-metadata";

// The operator's page. Deliberately handle-only: bigdev's public identity is
// @bigdev_xrd / @bigdevxrd and nothing else belongs here — no legal name, no
// location, no employer. Anyone editing this page should keep it that way.
//
// No hard stats in the copy either (commit counts, test counts, endpoint
// counts). /about's Operator card tried that and every number drifted — two of
// them into overclaiming. Numbers that need a human to remember to update are
// numbers that end up lying; the on-chain addresses and the live repo are the
// verifiable surface instead.

export const metadata: Metadata = withPageOg("/bigdev", {
  title: "bigdev — Radix Guild",
  description:
    "Solo developer building on Radix. Radix Guild is the current project — Scrypto escrow, dashboard, and bot, built with AI and running on mainnet. No independent audit yet.",
});

function BigdevContent() {
  const giftsLive = isGiftPageLive();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">bigdev</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The person who builds and runs the Guild.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 pb-5 pt-5">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary">
              BD
            </div>
            <div className="min-w-0">
              <div className="text-base font-bold">bigdev</div>
              <div className="font-mono text-xs text-muted-foreground">@bigdev_xrd</div>
            </div>
          </div>

          <div className="space-y-3 text-sm leading-relaxed">
            <p>Solo developer, building on Radix.</p>
            <p>
              {/* bigdev's own words, chosen 2026-09-19 (Option A). The line this
                  replaced — "contracts through to CSS, written end to end by one
                  person" — read as hands-on craftsmanship and said nothing about
                  AI, which contradicted the Beta 1 announcement. It also shows in
                  link previews via `metadata.description` above; keep the two
                  telling the same story. */}
              Radix Guild is the current project: a Scrypto escrow blueprint, a Next.js
              dashboard, and a Telegram bot, running on mainnet — built by one person, with AI.
              Most of it, contracts included, started as an AI draft that I read, tested and
              shipped. I&apos;m not a smart-contract engineer by trade, and I don&apos;t yet
              understand every part of it as well as I&apos;d like. No independent audit has been
              done. Self-funded: no raise, no token, no treasury. If something here looks wrong,
              telling me is the most useful thing you can do.
            </p>
            <p>
              The admin badge stays with bigdev for now. The aim is to hand it to the Radix
              DAO once the DAO is formed — interim by design, no date set, and who holds it
              today is on-ledger.
            </p>
            <p>
              Bias: working software over whitepapers, verifiable claims over adjectives. If a
              page here claims more than the code delivers, that&apos;s a bug — report it.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <a
              href="https://github.com/bigdevxrd"
              target="_blank"
              rel="noopener noreferrer"
              className="no-underline"
            >
              <Badge variant="outline" className="cursor-pointer text-xs hover:bg-muted">
                GitHub @bigdevxrd
              </Badge>
            </a>
            <a
              href="https://t.me/bigdev_xrd"
              target="_blank"
              rel="noopener noreferrer"
              className="no-underline"
            >
              <Badge variant="outline" className="cursor-pointer text-xs hover:bg-muted">
                Telegram @bigdev_xrd
              </Badge>
            </a>
            <a href={TG_BOT_URL} target="_blank" rel="noopener noreferrer" className="no-underline">
              <Badge variant="outline" className="cursor-pointer text-xs hover:bg-muted">
                Guild bot
              </Badge>
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Gifts sit BELOW the bio on purpose: a reader should know who they are
          giving to before they are asked. The whole block is conditional — with
          no destination configured the rails are dark (lib/gift.ts) and an
          orphan "Gifts" heading over nothing would be its own small lie. This
          page never 404s for that reason; the bio is the point. */}
      {giftsLive && (
        <>
          <Separator />
          <div>
            <h2 className="text-lg font-bold">Gifts</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The platform fee is 0% during beta. Gifts are what cover the bills in the meantime.
            </p>
          </div>
          <GiftDisclosure />
          <GiftRails />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        <Link href="/about" className="text-primary hover:underline">
          ← About Radix Guild
        </Link>
      </p>
    </div>
  );
}

export default function BigdevPage() {
  return (
    <AppShell>
      <BigdevContent />
    </AppShell>
  );
}
