"use client"

import { useEffect, useRef, useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CopyButton } from "@/components/copy-button"
import { useWallet } from "@/hooks/useWallet"
import { signInDidNotComplete } from "@/lib/session-outcome"
import { apiFetch } from "@/lib/api-fetch"
import { AGENT_LABEL_MAX, AGENT_LABEL_RULE, isValidAgentLabel } from "@/lib/agent-label"
import { KIT_CHECK_BY_EYE, KIT_SHA256 } from "@/lib/kit"

/** How often the waiting step asks whether the agent has used the code. */
const PAIR_POLL_MS = 5_000
/** Past its expiry, how long to keep asking the server before saying we could not confirm. */
const FINAL_CHECK_MS = 60_000

type Issued = { code: string; label: string; labelNorm: string; expiresAt: string; oneLiner: string }
type Step =
  | { kind: "name" }
  | { kind: "waiting"; issued: Issued }
  /** The code's time is up on this clock; the server has the last word on whether it was used. */
  | { kind: "expiring"; issued: Issued }
  | { kind: "paired"; label: string }
  | { kind: "expired" }
  /** No verdict a minute past the expiry. Keeps asking: a slow "redeemed" still lands. */
  | { kind: "unconfirmed"; issued: Issued }

const NAME_RULE = AGENT_LABEL_RULE

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** What GET /agents/codes/{code} says about one code — read from its own row. */
type CodeStatus = "open" | "redeemed" | "expired"

async function askCodeStatus(code: string): Promise<CodeStatus | null> {
  try {
    const res = await apiFetch(`/api/v1/agents/codes/${encodeURIComponent(code)}`)
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    const status = body?.ok ? body.data?.status : null
    return status === "open" || status === "redeemed" || status === "expired" ? status : null
  } catch {
    return null
  }
}

/**
 * Add an agent, up to the point it checks in (design §1a steps 1–2, A2.2):
 * name it → get the line to paste into it → wait until it redeems the code.
 * Funding is the next step, on its card (A2.3). Shown only while the
 * `agentsAdd` flag is on, which is flipped at S1 when the kit is served —
 * before that the line would point at nothing.
 */
export function AddAgentDialog({ onChanged }: { onChanged: () => void }) {
  const { ensureSessionDetailed } = useWallet()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>({ kind: "name" })
  const [label, setLabel] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // The same Issued object through waiting → expiring, so the effect below is
  // NOT torn down when this clock says time is up: an answer already on its way
  // still counts.
  const active = step.kind === "waiting" || step.kind === "expiring" || step.kind === "unconfirmed" ? step.issued : null
  // Bumped on every close: a code request still in flight when the dialog
  // closed must not reopen into it.
  const generation = useRef(0)

  // Every way out resets: a reopened dialog starts a new agent, never shows an
  // old code. (onOpenChange fires only for the user's own close — the Done
  // button closes programmatically, so it calls this too.)
  const close = () => {
    generation.current++
    setSubmitting(false)
    setOpen(false)
    setStep({ kind: "name" })
    setLabel("")
    setError(null)
    onChanged()
  }

  // While a code is open: tick the countdown every second and ask the server
  // about THIS code every PAIR_POLL_MS. The server decides — redeemed → paired,
  // expired → expired — from the code's own row. When this clock reaches the
  // expiry the step becomes "expiring" and keeps asking; no answer within
  // FINAL_CHECK_MS → unconfirmed, never a guess.
  // State changes only in callbacks, and only while THIS code is still the
  // current one: `cancelled` covers an answer landing after a close or a new
  // code, the functional updates cover the rest.
  useEffect(() => {
    if (!active) return
    const expiresAt = Date.parse(active.expiresAt)
    const isCurrent = (s: Step) =>
      (s.kind === "waiting" || s.kind === "expiring" || s.kind === "unconfirmed") && s.issued.code === active.code
    let cancelled = false
    const check = () => {
      askCodeStatus(active.code).then((status) => {
        if (cancelled || status === null) return // no answer: ask again next time
        if (status === "redeemed") {
          setStep((s) => (isCurrent(s) ? { kind: "paired", label: active.label } : s))
          onChanged()
        } else if (status === "expired") {
          setStep((s) => (isCurrent(s) ? { kind: "expired" } : s))
        }
      })
    }
    let askedAtExpiry = false
    const tick = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t < expiresAt) return
      setStep((s) => (isCurrent(s) && s.kind === "waiting" ? { kind: "expiring", issued: s.issued } : s))
      if (!askedAtExpiry) {
        askedAtExpiry = true
        check()
      }
      if (t >= expiresAt + FINAL_CHECK_MS) {
        setStep((s) => (isCurrent(s) && s.kind === "expiring" ? { kind: "unconfirmed", issued: s.issued } : s))
      }
    }, 1_000)
    const poll = setInterval(check, PAIR_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [active, onChanged])

  const handleCreate = async () => {
    const gen = generation.current
    const stale = () => gen !== generation.current // the dialog closed meanwhile
    const name = label.trim()
    setError(null)
    if (!isValidAgentLabel(name)) {
      setError(NAME_RULE)
      return
    }
    setSubmitting(true)
    try {
      const gate = await ensureSessionDetailed()
      if (stale()) return
      if (!gate.ok) {
        setError(signInDidNotComplete("no agent code was created", gate))
        return
      }
      const res = await apiFetch("/api/v1/agents/codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: name }),
      })
      const body = await res.json().catch(() => null)
      // Closed while the code was being made: drop it. It stays open on the
      // server until it expires, or until the next code for this name ends it.
      if (stale()) return
      if (res.status === 429) {
        const wait = Number(res.headers.get("Retry-After")) || 60
        setError(`Too many tries. Wait ${wait} seconds and try again.`)
        return
      }
      if (!res.ok || !body?.ok) {
        setError(body?.error?.message ?? `Something went wrong (HTTP ${res.status}). Try again.`)
        return
      }
      setNow(Date.now())
      setStep({ kind: "waiting", issued: body.data as Issued })
      onChanged()
    } catch {
      if (!stale()) setError("Couldn't reach the Guild. Check your connection and try again.")
    } finally {
      // A request abandoned by a close must not touch a newer attempt's button.
      if (!stale()) setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <Plus className="mr-1 h-4 w-4" />
        Add an agent
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription>
            Pair an agent you run yourself with your account. Funding it comes next, from its card.
          </DialogDescription>
        </DialogHeader>

        {step.kind === "name" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              handleCreate()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={label}
                maxLength={AGENT_LABEL_MAX}
                autoComplete="off"
                autoFocus
                aria-describedby="agent-name-rule"
                onChange={(e) => setLabel(e.target.value)}
              />
              <p id="agent-name-rule" className="text-xs text-muted-foreground">
                {NAME_RULE}
              </p>
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting || label.trim() === ""}>
              {submitting ? "Creating…" : "Create pairing code"}
            </Button>
          </form>
        )}

        {step.kind === "waiting" && (
          <div className="space-y-3">
            <p>Run this on the machine where your agent lives:</p>
            <div className="flex items-start gap-2">
              <code className="block flex-1 rounded-md bg-muted p-2 font-mono text-xs break-all">
                {step.issued.oneLiner}
              </code>
              <CopyButton value={step.issued.oneLiner} />
            </div>
            {/* S1 (design §2.4 "Integrity"): the hash beside the line, every time the line is
                shown. A person who was handed a lookalike line has no other way to tell. */}
            <p className="text-xs text-muted-foreground" data-testid="kit-hash-line">
              {KIT_SHA256 ? (
                <>
                  The kit it fetches has sha256{" "}
                  <code className="font-mono break-all">{KIT_SHA256}</code>. Check before you run it:{" "}
                  <code className="font-mono break-all">{KIT_CHECK_BY_EYE}</code> must print the same hex.
                </>
              ) : (
                <>This build serves no kit — the deployed site prints the tarball&rsquo;s sha256 here.</>
              )}{" "}
              Copy this line only from radixguild.com, never from a message.
            </p>
            <p className="text-xs text-muted-foreground">
              When it checks in, your agent prints its own account address. Keep that line: you compare the
              address before funding.
            </p>
            {/* Only the sentence is live; the countdown beside it changes every
                second and would otherwise be re-announced every second. */}
            <p className="text-sm">
              <span role="status">
                Waiting for <span className="font-semibold">{step.issued.label}</span> to check in…
              </span>{" "}
              <span data-testid="code-expiry">
                code <span className="font-mono">{step.issued.code}</span> expires in{" "}
                {mmss(Date.parse(step.issued.expiresAt) - now)}.
              </span>
            </p>
          </div>
        )}

        {step.kind === "paired" && (
          <div className="space-y-3">
            <p role="status">
              <span className="font-semibold">{step.label}</span> checked in and is on your list. Fund it from its card.
            </p>
            <Button className="w-full" onClick={close}>
              Done
            </Button>
          </div>
        )}

        {step.kind === "expiring" && (
          <p role="status" aria-busy="true" className="text-sm">
            The code&apos;s time is up — checking one last time whether your agent used it…
          </p>
        )}

        {step.kind === "unconfirmed" && (
          <div className="space-y-3">
            <p role="alert">
              We couldn&apos;t confirm whether your agent used the code. If it did, it appears in your list shortly; if not,
              create a new code.
            </p>
            <Button className="w-full" onClick={() => setStep({ kind: "name" })}>
              Create a new code
            </Button>
          </div>
        )}

        {step.kind === "expired" && (
          <div className="space-y-3">
            <p role="alert">That code expired before your agent used it. Nothing was paired.</p>
            <Button className="w-full" onClick={() => setStep({ kind: "name" })}>
              Create a new code
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
