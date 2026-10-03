import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { GiftDisclosure, GiftRails } from "@/components/gift/gift-rails";
import { isGiftPageLive } from "@/lib/gift";
import { withPageOg } from "@/lib/page-metadata";

export const metadata: Metadata = withPageOg("/gift", {
  title: "Gifts — Radix Guild",
  description:
    "The guild takes 0% during beta. Gifts cover the bills until fees switch on. A gift buys nothing — no token, no equity, no priority.",
});

function GiftContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Gifts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The platform fee is 0% during beta. Gifts are what cover the bills in the meantime.
        </p>
      </div>

      <GiftDisclosure />
      <GiftRails />
    </div>
  );
}

export default function GiftPage() {
  // The hard guard, at the route boundary: with no destination configured there
  // is nothing to send to, so the page does not exist at all. See lib/gift.ts.
  // (/bigdev embeds the same rails but must NOT 404 when gifts are dark — the
  // bio is the point there, and the rails just disappear.)
  if (!isGiftPageLive()) notFound();
  return (
    <AppShell>
      <GiftContent />
    </AppShell>
  );
}
