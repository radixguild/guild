"use client";
import { useState, useEffect } from "react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { isEnabled } from "@/lib/features";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { useWallet } from "@/hooks/useWallet";
import { SCHEMAS, TIER_COLORS, ROYALTIES } from "@/lib/constants";
import { lookupAllBadges, holdsFungibleBadgeResult } from "@/lib/gateway";
import { ADMIN_BADGE } from "@/lib/config";
import { updateTierManifest, updateXpManifest, revokeBadgeManifest, updateExtraDataManifest } from "@/lib/manifests";
import type { BadgeInfo } from "@/lib/types";

function AdminContent() {
  const { account, rdt } = useWallet();
  const [badges, setBadges] = useState<BadgeInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [lookupAddr, setLookupAddr] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [actionTxId, setActionTxId] = useState("");
  const [actionError, setActionError] = useState("");

  async function handleLookup(address: string) {
    if (!address) return;
    setLoading(true); setBadges([]);
    setBadges(await lookupAllBadges(address));
    setLoading(false);
  }

  // `build` runs inside the try: a builder that refuses its input (a bad badge
  // id) shows the error instead of leaving the button silently dead.
  async function sendAdminTx(build: () => string, label: string) {
    if (!rdt || !account) return;
    setActionStatus(`${label}...`); setActionTxId(""); setActionError("");
    try {
      const manifest = build();
      const result = await rdt.walletApi.sendTransaction({ transactionManifest: manifest, version: 1 });
      if (result.isOk()) { setActionStatus(`${label} complete!`); setActionTxId(result.value.transactionIntentHash); }
      else { setActionError(JSON.stringify(result.error)); setActionStatus(""); }
    } catch (e: unknown) { setActionError(e instanceof Error ? e.message : "Failed"); setActionStatus(""); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Badge Manager</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage Guild badges across all schemas</p>
      </div>

      {/* Badge Lookup */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Look Up Badges</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={lookupAddr} onChange={(e) => setLookupAddr(e.target.value)} placeholder="account_rdx1..." className="font-mono text-[13px]" />
            <Button onClick={() => handleLookup(lookupAddr)}>Search</Button>
          </div>
          {account && (
            <Button variant="ghost" size="sm" onClick={() => { setLookupAddr(account); handleLookup(account); }}>
              Check my badges
            </Button>
          )}
          {loading && <p className="text-muted-foreground text-sm">Loading...</p>}
          {badges.length > 0 && (
            <div className="space-y-0">
              {badges.map((b) => (
                <div key={b.id} className="flex items-center justify-between py-3 border-b last:border-0">
                  <div>
                    <div className="font-semibold text-sm">{b.issued_to}</div>
                    <div className="text-xs text-muted-foreground">{b.schema_name} | {b.id}</div>
                  </div>
                  <div className="text-right">
                    <Badge style={{ backgroundColor: `${TIER_COLORS[b.tier]}20`, color: TIER_COLORS[b.tier], border: "none" }}>{b.tier}</Badge>
                    <div className="text-[11px] text-muted-foreground mt-1">XP: {b.xp} | {b.status}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && badges.length === 0 && lookupAddr && <p className="text-muted-foreground text-sm">No badges found.</p>}
        </CardContent>
      </Card>

      {/* Admin Actions */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Admin Actions</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">Requires admin badge in connected wallet. Royalties apply.</p>
          <Separator />
          {/* No "Mint Role Badge" (removed 2026-09-23): the guild_role manager is
              retired and each mint paid it a 1 XRD royalty. See schemas.ts. */}
          <ActionForm label="Update Tier" cost={ROYALTIES.update_tier}
            fields={[{ name: "badgeId", ph: "<guild_member_bigdevxrd>" }, { name: "newTier", ph: "", type: "select", opts: SCHEMAS.guild_member.tiers }]}
            onSubmit={(v) => sendAdminTx(() => updateTierManifest(SCHEMAS.guild_member.manager, SCHEMAS.guild_member.adminBadge, v.badgeId, v.newTier, account!), "Updating tier")} />
          <ActionForm label="Update XP" cost={ROYALTIES.update_xp}
            fields={[{ name: "badgeId", ph: "<guild_member_bigdevxrd>" }, { name: "newXp", ph: "100", type: "number" }]}
            onSubmit={(v) => sendAdminTx(() => updateXpManifest(SCHEMAS.guild_member.manager, SCHEMAS.guild_member.adminBadge, v.badgeId, parseInt(v.newXp), account!), "Updating XP")} />
          <ActionForm label="Revoke Badge" cost={ROYALTIES.revoke} variant="destructive"
            fields={[{ name: "badgeId", ph: "<guild_member_bigdevxrd>" }, { name: "reason", ph: "Reason" }]}
            onSubmit={(v) => sendAdminTx(() => revokeBadgeManifest(SCHEMAS.guild_member.manager, SCHEMAS.guild_member.adminBadge, v.badgeId, v.reason, account!), "Revoking")} />
          <ActionForm label="Update Extra Data" cost={ROYALTIES.update_extra_data}
            fields={[{ name: "badgeId", ph: "<guild_member_bigdevxrd>" }, { name: "data", ph: '{"role":"mod"}' }]}
            onSubmit={(v) => sendAdminTx(() => updateExtraDataManifest(SCHEMAS.guild_member.manager, SCHEMAS.guild_member.adminBadge, v.badgeId, v.data, account!), "Updating")} />

          {(actionStatus || actionError) && (
            <Alert variant={actionError ? "destructive" : "default"}>
              <AlertDescription>
                {actionError || actionStatus}
                {actionTxId && <a href={`https://dashboard.radixdlt.com/transaction/${actionTxId}`} target="_blank" rel="noopener noreferrer" className="block mt-1 text-xs text-primary hover:underline">View on Dashboard</a>}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Schemas */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Badge Schemas</CardTitle></CardHeader>
        <CardContent>
          {Object.entries(SCHEMAS).map(([name, s]) => (
            <div key={name} className="py-3 border-b last:border-0">
              <div className="flex justify-between">
                <span className="font-semibold text-sm">{name}</span>
                <Badge variant={s.freeMint ? "default" : "secondary"}>{s.freeMint ? "Free mint" : "Admin only"}</Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-1">Tiers: {s.tiers.join(" / ")} | Manager: {s.manager.slice(0, 25)}...</div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function ActionForm({ label, cost, fields, onSubmit, variant = "default" }: {
  label: string; cost: number; variant?: "default" | "secondary" | "destructive";
  fields: { name: string; ph: string; type?: string; opts?: string[] }[];
  onSubmit: (v: Record<string, string>) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, f.opts?.[0] || ""]))
  );
  const set = (k: string, v: string) => setVals((p) => ({ ...p, [k]: v }));
  const ok = fields.every((f) => f.opts || vals[f.name]?.trim());

  return (
    <div className="bg-muted rounded-lg p-3.5">
      <div className="flex justify-between mb-2">
        <span className="text-[13px] font-semibold">{label}</span>
        <span className="text-[11px] text-yellow-500 font-mono">{cost} XRD</span>
      </div>
      <div className="flex gap-2 flex-wrap">
        {fields.map((f) => f.type === "select" ? (
          <select key={f.name} value={vals[f.name]} onChange={(e) => set(f.name, e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-[13px] font-mono w-36">
            {f.opts?.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <Input key={f.name} type={f.type || "text"} value={vals[f.name]} onChange={(e) => set(f.name, e.target.value)}
            placeholder={f.ph} className="flex-1 min-w-[140px] text-[13px] font-mono" />
        ))}
        <Button onClick={() => ok && onSubmit(vals)} disabled={!ok} variant={variant} size="sm">
          {label}
        </Button>
      </div>
    </div>
  );
}

// Minimal client gate (T2): the badge manager rendered for anyone at /admin
// (middleware covers only /api). The blueprint enforces real permissions
// on-chain, so this is UX/surface hygiene — not a funds control — but the page
// shouldn't render its operator tooling to a random visitor. Require the
// connected account to hold the operator badge before rendering; full
// useWallet-level gating stays deferred (OVERHAUL-HANDOFF.md:110).
//
// The operator badge (ADMIN_BADGE) is FUNGIBLE: supply 1, divisibility 0. So
// "holds it" means a fungible balance of at least 1. Until 2026-09-23 this
// gate asked the NFT lookup (loadUserBadge), which cannot see a fungible, and
// denied everyone, the badge's holder included.
type AdminVerdict = "allowed" | "denied" | "unavailable";

function AdminGate({ children }: { children: React.ReactNode }) {
  const { account } = useWallet();
  // Track WHICH account a resolved verdict belongs to. On an account switch the
  // prior verdict must not leak — an A="allowed" must never render the operator
  // tooling for a freshly-connected, not-yet-checked B. Until the resolver for
  // the CURRENT account lands, the derived status below reads "loading".
  const [checked, setChecked] = useState<{ account: string | null; status: AdminVerdict }>(
    { account: null, status: "denied" },
  );

  useEffect(() => {
    let live = true;
    // All setState happens in the async callback (never synchronously in the
    // effect body): no account resolves to denied; a held operator badge to
    // allowed; a lookup that could not answer to unavailable, which withholds
    // the tooling exactly like denied (fail closed) but does not tell the
    // operator their wallet lacks a badge it may well hold. The result is
    // tagged with the account it was resolved for.
    const resolveStatus = async (): Promise<AdminVerdict> => {
      if (!account) return "denied";
      const result = await holdsFungibleBadgeResult(account, ADMIN_BADGE);
      if (!result.ok) return "unavailable";
      return result.held ? "allowed" : "denied";
    };
    resolveStatus()
      .then((s) => { if (live) setChecked({ account, status: s }); })
      .catch(() => { if (live) setChecked({ account, status: "unavailable" }); });
    return () => { live = false; };
  }, [account]);

  // Only trust a verdict resolved for the account currently connected.
  const status = checked.account === account ? checked.status : "loading";

  if (status === "allowed") return <>{children}</>;

  return (
    <Card className="max-w-md">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          Operator access
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {status === "loading"
          ? "Checking operator access…"
          : status === "unavailable"
            ? "Couldn't check this wallet for the operator badge: the Radix Gateway lookup failed. Reload to try again. The badge manager stays hidden until the check succeeds."
            : account
              ? "This wallet doesn't hold the operator badge. The badge manager is operator-only (on-chain permissions are enforced regardless)."
              : "Connect the operator wallet to open the badge manager."}
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  // FLAGS.admin (default ON — operator use is unchanged on a clean deploy).
  // Setting NEXT_PUBLIC_FEATURE_ADMIN=false makes the route 404 outright.
  // Build-time flag, so flipping it requires a rebuild — same trade-off as
  // every other NEXT_PUBLIC_ gate. The wallet-side AdminGate below (and the
  // on-chain operator-badge requirement on every manifest) remain the real
  // enforcement; this just removes the surface entirely when disabled.
  if (!isEnabled("admin")) notFound();
  return <AppShell><AdminGate><AdminContent /></AdminGate></AppShell>;
}
