import type { MetadataRoute } from "next";
import { isGiftPageLive } from "@/lib/gift";
import { isEnabled } from "@/lib/features";

// Public, indexable routes for crawlers. robots.txt advertises /sitemap.xml,
// which this generates (App Router convention). Operator-only (/admin,
// /deploy-escrow), API, and data-dependent dynamic routes (/tasks/[id],
// /profile/[address], /projects/[slug]) are omitted; redirects (since the
// MVP-5 merges, /start and /how-it-works) are left out too. /decisions,
// /governance, /proposals* and /governance-status were removed outright
// 2026-09-04 (bigdev's instruction) — they no longer exist at all, not merely
// unlisted.
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "https://radixguild.com").replace(/\/$/, "");

const ROUTES: {
  path: string;
  priority: number;
  changeFrequency: "hourly" | "daily" | "weekly" | "monthly";
}[] = [
  { path: "/", priority: 1.0, changeFrequency: "daily" },
  { path: "/tasks", priority: 0.9, changeFrequency: "hourly" },
  { path: "/projects", priority: 0.8, changeFrequency: "daily" },
  { path: "/ledger", priority: 0.6, changeFrequency: "daily" },
  { path: "/mint", priority: 0.7, changeFrequency: "weekly" },
  // /guide absorbed /start and /how-it-works (both redirect here now), so it
  // carries /start's old 0.9 priority as the single onboarding entry point.
  { path: "/guide", priority: 0.9, changeFrequency: "monthly" },
  { path: "/agents", priority: 0.7, changeFrequency: "monthly" },
  { path: "/money", priority: 0.7, changeFrequency: "monthly" },
  { path: "/lifecycle", priority: 0.7, changeFrequency: "monthly" },
  { path: "/leaderboard", priority: 0.6, changeFrequency: "daily" },
  { path: "/docs", priority: 0.6, changeFrequency: "weekly" },
  { path: "/trust", priority: 0.6, changeFrequency: "monthly" },
  { path: "/check-badge", priority: 0.6, changeFrequency: "monthly" },
  { path: "/disputes", priority: 0.5, changeFrequency: "monthly" },
  { path: "/about", priority: 0.6, changeFrequency: "monthly" },
  { path: "/bug-bounty", priority: 0.6, changeFrequency: "monthly" },
  { path: "/tasks/create", priority: 0.5, changeFrequency: "monthly" },
  { path: "/auditor-guide", priority: 0.5, changeFrequency: "monthly" },
  { path: "/bigdev", priority: 0.4, changeFrequency: "monthly" },
  // Added 2026-09-20 — live, indexable and simply missing (a site-wide audit found them).
  // /fund/create is a form, not a destination, so it stays out alongside /tasks/create's peers.
  { path: "/swaps", priority: 0.5, changeFrequency: "weekly" },
  { path: "/groups", priority: 0.5, changeFrequency: "weekly" },
  { path: "/lights-on", priority: 0.5, changeFrequency: "monthly" },
];

// /fund is listed ONLY while community funding is switched on. Every /fund page
// notFound()s behind NEXT_PUBLIC_FEATURE_CROWDFUND (and the nav entry is built from
// the same flag), so listing it unconditionally advertised a 404 to crawlers the
// moment the flag went off — bigdev switched crowdfunding off for launch, 2026-09-24.
// Same pattern as /gift below: one flag, every surface.
const FUND_ROUTE = { path: "/fund", priority: 0.5, changeFrequency: "weekly" } as const;

// /gift is listed ONLY when a destination is configured. The route 404s
// otherwise (lib/gift.ts), and a sitemap that advertises a 404 is a crawl
// error we asked for. Same single truth condition as the page and the footer
// link — three surfaces, one condition, no drift.
const GIFT_ROUTE = { path: "/gift", priority: 0.4, changeFrequency: "monthly" } as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const routes = [
    ...ROUTES,
    ...(isEnabled("crowdfund") ? [FUND_ROUTE] : []),
    ...(isGiftPageLive() ? [GIFT_ROUTE] : []),
  ];
  return routes.map((r) => ({
    url: `${SITE}${r.path}`,
    lastModified,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));
}
