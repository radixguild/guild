"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadFailed } from "@/components/ui/load-failed";
import { InfoTip } from "@/components/info-tip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api-fetch";
import { useWallet } from "@/hooks/useWallet";
import { signInDidNotComplete } from "@/lib/session-outcome";
import { Bell, BellOff, BellRing, Check, Filter, X, Megaphone } from "lucide-react";

// Working groups — Model A, interest channels (docs/design/working-groups-model-a.md).
//
// This page REPLACED a read-only proxy of the retiring Telegram bot's Model-B
// groups (leads, charters, sunset dates, "report overdue"). That model was
// explicitly buried, not extended: WGs are discovery and routing, never
// governance — the funding curve is the decision venue.
//
// Layout follows the anti-fragmentation research: the MEMBER FEED leads, and the
// category cards come after. A wall of (often empty) category cards as the first
// thing a member sees is the documented failure mode of this pattern.

type Level = "muted" | "normal" | "tracking" | "watching";

interface Group {
  id: number;
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  openTaskCount: number;
  viewerLevel: Level | null;
}

interface FeedItem {
  id: number;
  title: string;
  status: string;
  rewardXrd: string;
  createdAt: string;
  groupSlug: string;
  groupName: string;
}

const LEVEL_NEXT: Record<Level, Level> = {
  // The bell cycles through the three JOINED levels. `muted` is reachable from
  // the cycle but never lands you outside the group — leaving is its own action,
  // so a mis-click on a bell can never drop a membership.
  normal: "tracking",
  tracking: "watching",
  watching: "muted",
  muted: "normal",
};

const LEVEL_LABEL: Record<Level, string> = {
  muted: "Muted",
  normal: "Joined",
  tracking: "Tracking",
  watching: "Watching",
};

function LevelIcon({ level }: { level: Level }) {
  if (level === "muted") return <BellOff className="h-3.5 w-3.5" />;
  if (level === "watching") return <BellRing className="h-3.5 w-3.5" />;
  if (level === "tracking") return <Bell className="h-3.5 w-3.5" />;
  return <Check className="h-3.5 w-3.5" />;
}

// Step 6 — the propose-queue's member-facing half. Submits into
// working_group_proposals (a PENDING request), never creates a group directly:
// the catalog stays admin-curated (scripts/review-group-proposals.mjs), which
// is what keeps the board from fragmenting into empty channels.
function ProposeGroupDialog() {
  const { ensureSessionDetailed } = useWallet();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const gate = await ensureSessionDetailed();
      if (!gate.ok) {
        setError(signInDidNotComplete("no group was proposed", gate));
        return;
      }
      const res = await apiFetch("/api/v1/groups/propose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit proposal");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setName("");
    setDescription("");
    setError(null);
    setSubmitted(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Megaphone className="mr-1.5 h-3.5 w-3.5" />
        Propose a group
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Propose a working group</DialogTitle>
        </DialogHeader>
        {submitted ? (
          <div className="space-y-3 py-2">
            <p className="text-sm">
              Submitted. An admin reviews the queue and either creates the group or lets you know
              why not — groups are curated, not auto-created, so a small catalog stays useful.
            </p>
            <Button className="w-full" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="wg-propose-name">Name</Label>
              <Input
                id="wg-propose-name"
                placeholder="e.g. Security"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wg-propose-description">Why this group? (optional)</Label>
              <Textarea
                id="wg-propose-description"
                rows={3}
                placeholder="What work would route here that doesn't fit an existing group."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              className="w-full"
              onClick={handleSubmit}
              disabled={submitting || name.trim().length < 3}
            >
              {submitting ? "Submitting…" : "Submit for review"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GroupsContent() {
  const { account, ensureSessionDetailed } = useWallet();
  const [groups, setGroups] = useState<Group[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Step 5 — custom-feed browse: a filter over the SAME task feed, keyed by
  // slug, that needs no membership. Lets a visitor preview a group's work
  // (or a combination of several) before ever joining anything.
  const [browseSelected, setBrowseSelected] = useState<Set<string>>(new Set());
  const [browseFeed, setBrowseFeed] = useState<FeedItem[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);

  const joined = groups.filter((g) => g.viewerLevel !== null);

  useEffect(() => {
    let cancelled = false;
    // No setLoading(true) here, and that is deliberate twice over. Synchronously
    // in an effect body it trips react-hooks/set-state-in-effect (a cascading
    // render before the fetch starts); and on a REFETCH — after a join or a
    // level change — showing the skeleton again would blank content the user is
    // looking at to redraw the same thing. First load is covered by the initial
    // useState(true); refetches update in place.
    apiFetch("/api/v1/groups")
      .then((r) => r.json())
      .then(async (g) => {
        if (cancelled) return;
        const ok = Array.isArray(g?.data);
        setFailed(!ok);
        setGroups(ok ? g.data : []);
        // Only fetch the feed when signed in AND actually a member — an empty
        // feed for someone who has joined nothing is not a feed, it is noise.
        if (ok && account && g.data.some((x: Group) => x.viewerLevel !== null)) {
          const f = await apiFetch("/api/v1/groups/feed").then((r) => r.json()).catch(() => null);
          if (!cancelled && Array.isArray(f?.data)) setFeed(f.data);
        } else if (!cancelled) {
          setFeed([]);
        }
        if (!cancelled) setLoading(false);
      })
      .catch(() => {
        if (!cancelled) { setFailed(true); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [reloadKey, account]);

  // Join / change-level / leave.
  //
  // ⚠️ This function used to fail SILENTLY in two separate places, and an
  // external reporter found it on 2026-09-16 ("the Join button does not
  // respond"). Reproduced on production: clicking Join while disconnected
  // fired a 401 and changed nothing on screen — no toast, no modal, no
  // prompt. Both swallows are fixed below; neither may be reintroduced.
  //
  //   1. `if (!(await ensureSession())) return` — a bare early return. Every
  //      visitor without a connected wallet hit a dead button on the ONLY
  //      action this page has. The page did carry a "Connect your wallet to
  //      join a group" hint, but it sits below six cards and is off-screen on
  //      a tablet at the moment you tap.
  //   2. `if (res.ok) setReloadKey(...)` — with no else. Any 4xx/5xx from the
  //      membership route vanished.
  //
  // The reporter's second observation — "tapping other areas of the group
  // card can trigger the join action" — was the same bug seen from the other
  // side: the Preview button sits on this same card row, needs no session,
  // and visibly flips to "Previewing". Dead control on the left, responsive
  // one on the right, and a reasonable person concludes the card works and
  // the button doesn't.
  //
  // `setBusy` now brackets the session round-trip too, so the button shows a
  // pending state while the wallet signature is pending instead of looking
  // inert — the pattern ProposeGroupDialog in this same file already used.
  const mutate = useCallback(
    async (slug: string, next: Level | null) => {
      setBusy(slug);
      try {
        const gate = await ensureSessionDetailed();
        if (!gate.ok) {
          toast.error(signInDidNotComplete("you did not join", gate), {
            description: "Joining records the group against your Guild account, so it needs a signed-in session.",
          });
          return;
        }
        const res = await apiFetch(`/api/v1/groups/${slug}/membership`, {
          method: next === null ? "DELETE" : "PUT",
          ...(next === null ? {} : { body: JSON.stringify({ level: next }) }),
        });
        if (res.ok) {
          setReloadKey((k) => k + 1);
          return;
        }
        // Read the route's own message when it sent one rather than inventing
        // a generic failure — the membership route distinguishes badge-gate
        // from session-mismatch from not-found, and those are different
        // problems for the person reading the toast.
        const detail = await res
          .json()
          .then((b) => (typeof b?.error?.message === "string" ? b.error.message : null))
          .catch(() => null);
        toast.error(
          next === null ? "Couldn't leave that group." : "Couldn't join that group.",
          { description: detail ?? `The server refused the change (HTTP ${res.status}).` },
        );
      } catch {
        toast.error("Couldn't reach the Guild.", {
          description: "Check your connection and try again.",
        });
      } finally {
        setBusy(null);
      }
    },
    [ensureSessionDetailed],
  );

  // Fetched from the toggle/clear event handlers directly, NOT from a
  // useEffect watching browseSelected — that would call setState (the loading
  // flag) synchronously inside the effect body, which is exactly the
  // react-hooks/set-state-in-effect trap the member-feed load above already
  // avoids by never calling setLoading(true) on a refetch. An event handler
  // has no such restriction.
  const fetchBrowse = useCallback(async (slugs: Set<string>) => {
    if (slugs.size === 0) {
      setBrowseFeed([]);
      return;
    }
    setBrowseLoading(true);
    try {
      const qs = [...slugs].join(",");
      const res = await apiFetch(`/api/v1/groups/browse?groups=${encodeURIComponent(qs)}`);
      const body = await res.json().catch(() => null);
      setBrowseFeed(Array.isArray(body?.data) ? body.data : []);
    } catch {
      setBrowseFeed([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const toggleBrowse = useCallback(
    (slug: string) => {
      const next = new Set(browseSelected);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      setBrowseSelected(next);
      fetchBrowse(next);
    },
    [browseSelected, fetchBrowse],
  );

  const clearBrowse = useCallback(() => {
    setBrowseSelected(new Set());
    setBrowseFeed([]);
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1">
            <h1 className="text-2xl font-bold">Working Groups</h1>
            <InfoTip
              text="Interest channels for routing work. Joining a group filters tasks into your feed. The bell setting is recorded against your membership, but nothing sends notifications yet — that leg is designed and not switched on. Groups carry no permissions, no treasury and no vote — they decide nothing, they route."
              link="/docs"
            />
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            Join the areas you work in and the board comes to you. No permissions, no roles — leave any
            time.
          </p>
        </div>
        <ProposeGroupDialog />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : failed ? (
        <LoadFailed what="working groups" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : (
        <>
          {/* The member feed leads — the core value of the feature. */}
          {joined.length > 0 && (
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-sm">Your feed</span>
                  <span className="text-[10px] text-muted-foreground">
                    {joined.length} group{joined.length !== 1 ? "s" : ""} joined
                  </span>
                </div>
                {feed.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">
                    Nothing in your groups yet. New tasks routed to them will appear here.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {feed.map((t) => (
                      <Link
                        key={t.id}
                        href={`/tasks/${t.id}`}
                        className="flex items-center gap-2 py-1.5 px-2 -mx-2 rounded hover:bg-accent/40 transition-colors"
                      >
                        <Badge variant="outline" className="text-[9px] shrink-0">
                          {t.groupName}
                        </Badge>
                        <span className="text-xs truncate flex-1">{t.title}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {Number(t.rewardXrd) > 0 ? `${Number(t.rewardXrd)} XRD` : t.status}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {groups.map((g) => {
              const level = g.viewerLevel;
              const previewing = browseSelected.has(g.slug);
              return (
                <Card
                  key={g.id}
                  id={g.slug}
                  className={`h-full scroll-mt-20 transition-colors ${previewing ? "border-primary/60" : ""}`}
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <Link href={`/groups/${g.slug}`} className="font-semibold text-sm hover:underline">
                        {g.name}
                      </Link>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant="secondary" className="text-[9px]">
                          {g.openTaskCount} open
                        </Badge>
                        <Badge variant="secondary" className="text-[9px]">
                          {g.memberCount} member{g.memberCount !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">{g.description}</p>
                    <div className="flex items-center gap-1.5">
                      {level === null ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={busy === g.slug}
                          onClick={() => mutate(g.slug, "normal")}
                        >
                          Join
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-7 text-xs gap-1.5"
                            disabled={busy === g.slug}
                            onClick={() => mutate(g.slug, LEVEL_NEXT[level])}
                            title="Change notification level"
                          >
                            <LevelIcon level={level} />
                            {LEVEL_LABEL[level]}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground"
                            disabled={busy === g.slug}
                            onClick={() => mutate(g.slug, null)}
                          >
                            Leave
                          </Button>
                        </>
                      )}
                      {/* Step 5 — custom-feed browse: needs no membership, works
                          for a signed-out visitor too, so it's independent of
                          the join/leave state above. */}
                      <Button
                        size="sm"
                        variant={previewing ? "secondary" : "ghost"}
                        className="h-7 text-xs text-muted-foreground ml-auto gap-1"
                        onClick={() => toggleBrowse(g.slug)}
                        title={previewing ? "Remove from preview" : "Preview this group's feed"}
                      >
                        <Filter className="h-3 w-3" />
                        {previewing ? "Previewing" : "Preview"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {groups.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="py-8 text-center">
                <p className="text-muted-foreground text-sm">No working groups yet.</p>
              </CardContent>
            </Card>
          )}

          {/* Step 5 — the browse/filter panel: the union of every group toggled
              "Preview" above, no join required. */}
          {browseSelected.size > 0 && (
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="font-semibold text-sm flex items-center gap-1.5">
                    <Filter className="h-3.5 w-3.5" />
                    Browsing {browseSelected.size} group{browseSelected.size !== 1 ? "s" : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] text-muted-foreground gap-1"
                    onClick={clearBrowse}
                  >
                    <X className="h-3 w-3" />
                    Clear
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {[...browseSelected].map((slug) => (
                    <Badge key={slug} variant="outline" className="text-[9px]">
                      {groups.find((g) => g.slug === slug)?.name ?? slug}
                    </Badge>
                  ))}
                </div>
                {browseLoading ? (
                  <div className="space-y-1.5">
                    {[1, 2, 3].map((i) => <Skeleton key={i} className="h-6" />)}
                  </div>
                ) : browseFeed.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">
                    No open work in this selection right now.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {browseFeed.map((t) => (
                      <Link
                        key={t.id}
                        href={`/tasks/${t.id}`}
                        className="flex items-center gap-2 py-1.5 px-2 -mx-2 rounded hover:bg-accent/40 transition-colors"
                      >
                        <Badge variant="outline" className="text-[9px] shrink-0">
                          {t.groupName}
                        </Badge>
                        <span className="text-xs truncate flex-1">{t.title}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {Number(t.rewardXrd) > 0 ? `${Number(t.rewardXrd)} XRD` : t.status}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {!account && !loading && !failed && groups.length > 0 && (
        <div className="text-center text-xs text-muted-foreground">
          Connect your wallet to join a group and get a feed.
        </div>
      )}
    </div>
  );
}

export default function GroupsPage() {
  return <AppShell><GroupsContent /></AppShell>;
}
