import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { Toaster } from "sonner";
import { OG_IMAGE_URL } from "@/lib/page-metadata";

const inter = Inter({ subsets: ["latin"] });

// ⚠️ Title and description rewritten 2026-09-01. Both previously led with
// governance ("Task Marketplace & Governance", "Earn XP, complete tasks, and
// govern") — the framing the org retired in #460. The site title is
// the single most-syndicated string we own: it is the browser tab, the search
// result and the link preview, and it was still selling the pillar we had just
// removed from the product. Marketplace first, everywhere.
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://radixguild.com",
  ),
  title: "Radix Guild — Task Marketplace",
  description:
    "A task marketplace for the Radix community. Post work and fund it in on-chain escrow; humans and software agents claim it, deliver, and withdraw payment themselves.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    siteName: "Radix Guild",
    title: "Radix Guild — Task Marketplace",
    description:
      "A task marketplace for the Radix community. Post work and fund it in on-chain escrow; humans and software agents claim it, deliver, and withdraw payment themselves.",
    url: "/",
    images: [
      { url: OG_IMAGE_URL, width: 1200, height: 630, alt: "Radix Guild — task marketplace for the Radix community, funded in on-chain escrow" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Radix Guild — Task Marketplace",
    description:
      "A task marketplace for the Radix community. Post work and fund it in on-chain escrow; humans and software agents claim it, deliver, and withdraw payment themselves.",
    images: [OG_IMAGE_URL],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={inter.className}>
        <Providers>{children}</Providers>
        {/* mobileOffset is load-bearing, not cosmetic.
            The mobile bottom nav (components/app-shell.tsx) is
            `sm:hidden fixed bottom-0 ... h-14` — 56px of tap targets pinned to
            the bottom of the viewport. A bottom-right toast at sonner's
            default 24px offset lands directly on top of Home / Tasks / Create /
            Mint and eats taps for the toast's full ~4s lifetime.
            That matters here specifically because the FIRST toast this app
            ever shows is the "connect your wallet to join a group" error — so
            the fix for one silent-failure bug would have handed a tester a
            dead nav bar instead. 72px clears the 56px bar with a 16px gutter.
            Desktop keeps the default: there is no bottom nav above `sm`. */}
        <Toaster richColors position="bottom-right" mobileOffset={{ bottom: "72px" }} />
      </body>
    </html>
  );
}
