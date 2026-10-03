"use client"

import { useRef, useState } from "react"
import { SlidersHorizontal, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { XrdAmount } from "@/components/XrdAmount"
import { patchAgent, type Refusal } from "@/components/agents/owner-request"
import type { AgentCardData } from "@/components/agents/status"
import { GUILD_POSTERS, isAccountAddress, type AgentRules } from "@/lib/agent-rules"

interface Draft {
  posters: string[]
  newPoster: string
  maxBond: string
  maxClaims: string
}
type Field = "posters" | "maxBond" | "maxClaims" | "add"

const draftFrom = (r: AgentRules): Draft => ({
  posters: [...r.trustedPosters],
  newPoster: "",
  maxBond: r.maxBondXrd,
  maxClaims: String(r.maxClaimsPerDay),
})

/** Which field a server refusal is about (VALIDATION_ERROR issue paths, or the one rule with its own code). */
function fieldErrors(refusal: Refusal): { fields: Partial<Record<Field, string>>; rest: string | null } {
  const fields: Partial<Record<Field, string>> = {}
  if (refusal.code === "MAX_BOND_EXCEEDS_FLOAT") return { fields: { maxBond: refusal.message }, rest: null }
  const unplaced: string[] = []
  for (const issue of refusal.issues) {
    const field: Field | null = issue.path.startsWith("trustedPosters")
      ? "posters"
      : issue.path === "maxBondXrd"
        ? "maxBond"
        : issue.path === "maxClaimsPerDay"
          ? "maxClaims"
          : null
    if (field) fields[field] ??= issue.message
    else unplaced.push(issue.message)
  }
  if (refusal.issues.length === 0) return { fields, rest: refusal.message }
  return { fields, rest: unplaced.length > 0 ? `${refusal.message}: ${unplaced.join("; ")}` : null }
}

/**
 * The rules form (A2.4b, design §3.5): trusted posters, the largest bond, the
 * daily claim limit. Practice mode is not here — it is Start / Pause on the
 * card.
 *
 * Nothing here decides what the server will accept. The bounds it states come
 * from the card's `limits` (the server's own numbers); Save always submits the
 * whole v1 document with the rules it started from (`baseRules`) and shows
 * the server's answer — per field where the server names one. If the rules
 * changed since the dialog opened (another tab or device), the server refuses
 * and the owner starts again from the current ones. The draft is taken when
 * the dialog opens and is never reset by the list's refreshes while open.
 */
export function RulesDialog({
  agent,
  onUpdated,
  onChanged,
}: {
  agent: AgentCardData
  onUpdated: (card: AgentCardData) => void
  onChanged: () => void
}) {
  const busy = useRef(false)
  const [open, setOpen] = useState(false)
  const [base, setBase] = useState<AgentRules>(agent.rules)
  const [draft, setDraft] = useState<Draft>(() => draftFrom(agent.rules))
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [behind, setBehind] = useState(false)
  const [saving, setSaving] = useState(false)
  if (!agent.actions.edit) return null

  const startFrom = (rules: AgentRules) => {
    setBase(rules)
    setDraft(draftFrom(rules))
    setErrors({})
    setFormError(null)
    setBehind(false)
  }

  const addPoster = () => {
    const address = draft.newPoster.trim()
    if (!address) return
    if (!isAccountAddress(address)) {
      setErrors((e) => ({ ...e, add: "That is not a Radix account address (account_rdx1…)." }))
      return
    }
    if (draft.posters.includes(address)) {
      setErrors((e) => ({ ...e, add: "That poster is already on the list." }))
      return
    }
    setDraft((d) => ({ ...d, posters: [...d.posters, address], newPoster: "" }))
    setErrors((e) => ({ ...e, add: undefined, posters: undefined }))
  }

  const unchanged =
    draft.maxBond === base.maxBondXrd &&
    draft.maxClaims === String(base.maxClaimsPerDay) &&
    draft.posters.length === base.trustedPosters.length &&
    draft.posters.every((p, i) => p === base.trustedPosters[i])

  const save = async () => {
    if (busy.current) return
    busy.current = true
    setSaving(true)
    setErrors({})
    setFormError(null)
    try {
      const claims = draft.maxClaims.trim()
      const answer = await patchAgent(agent.id, {
        rules: {
          v: 1,
          trustedPosters: draft.posters,
          maxBondXrd: draft.maxBond.trim(),
          // A whole number goes as a number; anything else goes as typed, and
          // the server says what is wrong with it.
          maxClaimsPerDay: /^\d+$/.test(claims) ? Number(claims) : claims,
          dryRun: base.dryRun,
        },
        baseRules: base,
      })
      if (answer.kind === "card") {
        setOpen(false)
        onUpdated(answer.card)
        return
      }
      if (answer.kind === "reload") {
        if (answer.message) setFormError(answer.message)
        else setOpen(false)
        onChanged()
        return
      }
      const { fields, rest } = fieldErrors(answer.refusal)
      setErrors(fields)
      setFormError(rest)
      if (answer.reload) {
        setBehind(answer.refusal.code === "RULES_CHANGED")
        // RULES_CHANGED carries the current card: apply it now, so "Start
        // again" reads the server's rules, never this page's stale copy.
        if (answer.card) onUpdated(answer.card)
        else onChanged()
      }
    } finally {
      busy.current = false
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) startFrom(agent.rules)
        setOpen(next)
      }}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" data-testid="agent-rules" />}>
        <SlidersHorizontal className="mr-1 h-4 w-4" />
        Rules
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rules for {agent.label}</DialogTitle>
          <DialogDescription>
            Your agent reads these at every check-in. {base.dryRun ? "It is in practice mode" : "It is started"} — Start and Pause
            are on its card.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 text-sm"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <fieldset className="space-y-2">
            <legend className="font-medium">Trusted posters</legend>
            <p className="text-xs text-muted-foreground">
              Its rules allow claims only on tasks these accounts posted
              {draft.posters.length === 0 ? " — with none, no claims at all" : ""}. At most {agent.limits.maxTrustedPosters}.
            </p>
            <ul className="space-y-1" data-testid="poster-list">
              {draft.posters.map((address) => (
                <li key={address} className="flex items-start gap-2">
                  <span className="flex-1 font-mono text-xs break-all">{address}</span>
                  {GUILD_POSTERS.includes(address) && <Badge variant="outline">Guild</Badge>}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${address}`}
                    onClick={() => setDraft((d) => ({ ...d, posters: d.posters.filter((p) => p !== address) }))}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </li>
              ))}
            </ul>
            {errors.posters && (
              <p role="alert" className="text-xs text-destructive">
                {errors.posters}
              </p>
            )}
            <p className="text-xs" data-testid="poster-disclosure">
              Your agent will read and act on the task text of every poster you trust. Add only posters you know.
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="Poster account to trust"
                placeholder="account_rdx1…"
                value={draft.newPoster}
                onChange={(e) => {
                  const newPoster = e.target.value
                  setDraft((d) => ({ ...d, newPoster }))
                  setErrors((er) => ({ ...er, add: undefined }))
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    addPoster()
                  }
                }}
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" onClick={addPoster}>
                Add
              </Button>
            </div>
            {errors.add && (
              <p role="alert" className="text-xs text-destructive">
                {errors.add}
              </p>
            )}
          </fieldset>

          <div className="space-y-1">
            <Label htmlFor={`max-bond-${agent.id}`}>Largest bond per claim (XRD)</Label>
            <Input
              id={`max-bond-${agent.id}`}
              inputMode="decimal"
              value={draft.maxBond}
              aria-invalid={errors.maxBond ? true : undefined}
              onChange={(e) => {
                const maxBond = e.target.value
                setDraft((d) => ({ ...d, maxBond }))
              }}
            />
            <p className="text-xs text-muted-foreground">
              At most <XrdAmount amountXrd={agent.limits.maxBondXrd} />: its <XrdAmount amountXrd={agent.floatXrd} /> float less{" "}
              <XrdAmount amountXrd={agent.limits.feeReserveXrd} /> kept for network fees. A task whose bond is larger is outside its rules.
            </p>
            {errors.maxBond && (
              <p role="alert" className="text-xs text-destructive">
                {errors.maxBond}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor={`max-claims-${agent.id}`}>Claims a day</Label>
            <Input
              id={`max-claims-${agent.id}`}
              inputMode="numeric"
              value={draft.maxClaims}
              aria-invalid={errors.maxClaims ? true : undefined}
              onChange={(e) => {
                const maxClaims = e.target.value
                setDraft((d) => ({ ...d, maxClaims }))
              }}
            />
            <p className="text-xs text-muted-foreground">0 to {agent.limits.maxClaimsPerDay}. 0 allows no claims.</p>
            {errors.maxClaims && (
              <p role="alert" className="text-xs text-destructive">
                {errors.maxClaims}
              </p>
            )}
          </div>

          {formError && (
            <div role="alert" className="space-y-2 text-destructive">
              <p>{formError}</p>
              {behind && (
                <Button type="button" size="sm" variant="outline" onClick={() => startFrom(agent.rules)}>
                  Start again from the current rules
                </Button>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || unchanged || behind} data-testid="rules-save">
              Save rules
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
