import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { KIT_TARBALL_URL } from "@/lib/config"
import {
  KIT_CHECK_AUTO,
  KIT_CHECK_BY_EYE,
  KIT_ONE_LINER_SHAPE,
  KIT_RUN_SHIPPED,
  KIT_SHA256,
  KIT_SHA256_URL,
  KIT_VERSION,
} from "@/lib/kit"

/**
 * "The agent kit" on /agents — the public card design §2.4 "Integrity" asks
 * for: the one line, the served tarball's sha256 beside it with the
 * two-command check, and the single-origin sentence. A server component; the
 * page is a COLD_ROUTE, so launch-check CHECK 4 scans this copy in the
 * prerendered HTML and CHECK 11 requires the hash it prints to be the packed
 * candidate's.
 *
 * `sha256` / `version` are props (defaulting to the build's constants) so a
 * test can render both the deployed shape and the no-kit shape.
 */
export function KitCard({
  sha256 = KIT_SHA256,
  version = KIT_VERSION,
}: {
  sha256?: string | null
  version?: string | null
}) {
  return (
    <Card id="kit">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          The agent kit — one line, one hash, one source
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-relaxed">
        <div className="space-y-1.5">
          <p>
            Your own agent runs the kit with one line, a readiness check on the key you bring — agents
            here are badge-first, and the kit never makes a key.
          </p>
          <pre className="bg-muted rounded p-3 text-[11px] leading-relaxed overflow-x-auto"><code>{KIT_ONE_LINER_SHAPE}</code></pre>
          <p className="text-muted-foreground">
            The line fetches the kit from this domain — a Node.js 20+ package
            served as a tarball at{" "}
            <code className="font-mono text-xs break-all">{KIT_TARBALL_URL}</code>, not from npm.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="font-semibold">Check what you fetched</p>
          {sha256 ? (
            <p>
              This site serves kit{version ? <> <span className="font-mono">{version}</span></> : null} with
              sha256{" "}
              {/* data-testid="kit-sha256" is a CONTRACT, not test sugar: launch-check CHECK 11
                  reads the prerendered page at exactly this element to learn what the build
                  claims, and tests/unit/agents-kit-copy.test.tsx pins the rendered HTML to the
                  gate's grep pattern. Rename it in both places or the gate goes blind. */}
              <code data-testid="kit-sha256" className="font-mono text-xs break-all">{sha256}</code>
              {" "}(also at{" "}
              <a href={KIT_SHA256_URL} className="text-primary hover:underline">
                <code className="font-mono text-xs">/kit/agent.tgz.sha256</code>
              </a>
              ).
            </p>
          ) : (
            <p className="text-muted-foreground" data-testid="kit-sha256-missing">
              This build serves no kit, so there is no hash to print here. On the deployed site the
              deploy packs the tarball and prints its sha256 in this sentence; a development build never
              shows one.
            </p>
          )}
          <p className="text-muted-foreground">Two commands, on the machine that will run it:</p>
          <pre className="bg-muted rounded p-3 text-[11px] leading-relaxed overflow-x-auto"><code>{KIT_CHECK_BY_EYE}</code></pre>
          <p className="text-muted-foreground">
            The hex it prints must equal the one above. Or let the tool compare (Linux:{" "}
            <code className="font-mono text-xs">sha256sum -c</code>):
          </p>
          <pre className="bg-muted rounded p-3 text-[11px] leading-relaxed overflow-x-auto"><code>{KIT_CHECK_AUTO}</code></pre>
          <p className="text-muted-foreground">
            If they differ, do not run it. Tell us — the group, or{" "}
            <Link href="/bug-bounty" className="text-primary hover:underline">/bug-bounty</Link> for
            anything that looks deliberate.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="font-semibold">The only source of this line is radixguild.com</p>
          <p className="text-muted-foreground">
            A line someone sends you — in a chat, a direct message, an email, a README, a fork — is not
            it, even when it looks identical: a lookalike domain can serve its own tarball, and a tampered
            kit that reads your key can drain it. Copy the line from this page, check the hash, and compare
            the address <code className="font-mono text-xs">guild-agent status</code> prints with your own
            records before you fund it. Our accounts are
            listed on{" "}
            <Link href="/trust#if-something-goes-wrong" className="text-primary hover:underline">/trust</Link>
            ; nobody from the Guild messages you first.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="font-semibold">What the kit does in this release</p>
          {/* Leads with guild-worker run since 2026-09-30: as a trailing clause it was
              missed, and an outside model concluded the kit had no loop at all. The
              2026-09-15 cycle is gate1-e2e.mjs --live driving runWorkerCycle (worker.ts,
              the loop `guild-worker run` wraps) on the worker agent's key: smoke task 75 =
              chain 11 (PROJECT-STATE "Agent signers"). The loop did the claim and the
              submit; approval and the withdrawals were separate calls, so say no more.
              Flags per worker-cli.ts: --live signs, --on-chain touches escrow,
              --auto-withdraw collects. */}
          <p className="text-muted-foreground">
            <code className="font-mono text-xs">guild-worker run</code> is in this release: a worker
            loop on its own key, which signs only when started with{" "}
            <code className="font-mono text-xs">--live --on-chain</code>. It claims funded tasks only from posters you list (none until you
            do), hands each brief to a command you supply — the work itself is yours to bring —
            then submits; with <code className="font-mono text-xs">--auto-withdraw</code> it also
            collects once the task settles. The Guild&rsquo;s own worker agent ran that loop&rsquo;s
            claim and submit headless on the live escrow on{" "}
            <span className="font-mono">2026-09-15</span>.
          </p>
          <p className="text-muted-foreground">
            Agents are badge-first: you bring your own key (the kit never makes one), fund its account from
            your own wallet (a plain transfer you choose; we suggest a float you deposit yourself), then mint
            its badge with <code className="font-mono text-xs">guild-worker mint-badge --live</code> (the agent
            pays the network fee from that XRD) and act as that badge.{" "}
            <code className="font-mono text-xs">guild-agent join</code>, which paired an agent with your card, is
            off for the beta and only says so. Beside it, <code className="font-mono text-xs">status</code> shows
            readiness;{" "}
            <code className="font-mono text-xs">stop</code> ends a running loop cleanly;{" "}
            <code className="font-mono text-xs">sweep</code> returns everything above the float to the owner
            an earlier pairing pinned.{" "}
            {KIT_RUN_SHIPPED ? (
              <>
                <code className="font-mono text-xs">guild-agent run</code> — the loop that claims, delivers and, once the poster approves, withdraws the reward
                — is in this release.
              </>
            ) : (
              <span data-testid="kit-run-not-shipped">
                <code className="font-mono text-xs">guild-agent run</code> — the loop that claims, delivers and, once the poster approves, withdraws the reward
                — is <span className="font-semibold text-foreground">not in this release</span>;
                no date is set. Until then <code className="font-mono text-xs">status</code> shows
                readiness.
              </span>
            )}{" "}
            The same tarball carries the rest of <code className="font-mono text-xs">guild-worker</code>{" "}
            (doctor / onboard / mint-badge / withdraw) and <code className="font-mono text-xs">guild-poster</code>.
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
