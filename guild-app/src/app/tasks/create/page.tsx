"use client"

import { Suspense, useCallback, useRef, useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EscrowDepositButton } from "@/components/tasks/escrow-actions"
import { EscrowDisabledNotice } from "@/components/tasks/escrow-disabled-notice"
import { apiFetch } from "@/lib/api-fetch"
import {
  DELIVERABLE_TYPES,
  DELIVERABLE_DEFAULTS,
  DONE_CHECKS,
  LICENSES,
  LICENSE_LABELS,
  LEGACY_TEMPLATE_TYPES,
  canonicalTermsBlock,
  renderContractSummary,
  hasTerms,
  type DeliverableType,
  type DoneCheck,
  type TaskTerms,
} from "@/lib/task-terms"
import { INSURANCE_RATE, MIN_REWARD_XRD } from "@/lib/marketplace"
import { createStepBlockers, isFieldBlocked, type CreateBlockerField } from "@/lib/create-task-blockers"
import { useXrdUsd } from "@/lib/use-xrd-usd"
import { XrdAmount } from "@/components/XrdAmount"
import { useWallet } from "@/hooks/useWallet"
import { signInDidNotComplete } from "@/lib/session-outcome"
import { useEscrowPostingFrozen } from "@/hooks/useEscrowPostingFrozen"
import {
  PostingPausedNotice,
  POSTING_PAUSED_CREATE_DETAIL,
} from "@/components/tasks/posting-paused-notice"
import { ArrowLeft, ArrowRight, Check, Lock, FileText, AlertCircle } from "lucide-react"
import { AppShell } from "@/components/app-shell"

/** The reason line under the step buttons; inputs point at it via aria-describedby. */
const CONTINUE_BLOCKER_ID = "create-continue-blocker"

type Step = "what" | "reward" | "review" | "done"

const STEPS = [
  { id: "what" as Step, label: "What needs doing?", number: 1 },
  { id: "reward" as Step, label: "Reward & terms", number: 2 },
  { id: "review" as Step, label: "Review & post", number: 3 },
]

const TYPE_LABELS: Record<DeliverableType, { label: string; blurb: string }> = {
  code: { label: "Code", blurb: "PR against a repo" },
  design: { label: "Design", blurb: "Figma, assets, branding" },
  content: { label: "Content", blurb: "Docs, articles, copy" },
  research: { label: "Research", blurb: "Findings with sources" },
  ops: { label: "Ops", blurb: "Deploys, infra, config" },
}

const DONE_CHECK_LABELS: Record<DoneCheck, string> = {
  "tests-pass": "Tests pass",
  "ci-green": "CI green",
  "code-reviewed": "Code reviewed",
  deployed: "Deployed",
  "docs-updated": "Docs updated",
}

// Committed-terms chip — every term in the form is one of the two layers
// (docs/TASK-TERMS-DESIGN.md). Reward/insurance are contract-enforced; the
// structured terms are hashed into the on-chain brief (immutable evidence).
function LayerChip({ enforced }: { enforced?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${enforced ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
      {enforced ? <Lock className="h-2.5 w-2.5" /> : <FileText className="h-2.5 w-2.5" />}
      {enforced ? "enforced by contract" : "committed terms"}
    </span>
  )
}

// The page's only useSearchParams() caller, isolated so ITS Suspense boundary
// is the sole client-only subtree — see the export at the bottom of this file
// for why that isolation matters. Renders nothing; it just decodes the three
// legacy/deep-link query params and hands them to the parent once.
function DeepLinkParamsReader({ onResolve }: { onResolve: (params: URLSearchParams) => void }) {
  const searchParams = useSearchParams()
  useEffect(() => {
    onResolve(searchParams)
    // searchParams is a new object each render only when the query string
    // itself changes, so this intentionally does not depend on `onResolve`
    // (a stable ref from the caller) re-running the effect spuriously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])
  return null
}

function CreateTaskContent() {
  const router = useRouter()
  const { ensureSessionDetailed } = useWallet()
  // Client-side XRD→USD rate (fails open to null → XRD-only preview).
  const { rate: usdRate, stale: usdStale, ageSeconds: usdAgeSeconds, source: usdSource } = useXrdUsd()
  // W3 freeze: warn BEFORE the poster drafts, not at the fund step.
  const postingFrozen = useEscrowPostingFrozen()
  const [step, setStep] = useState<Step>("what")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [rewardXrd, setRewardXrd] = useState("")
  const [deadline, setDeadline] = useState("")
  // ?project= deep link (the "+ Task" button on a project page) preselects the
  // grouping; the picker lets any poster file under any project. App-layer
  // only — never part of the brief hash.
  const [projectId, setProjectId] = useState<number | null>(null)
  const [projectOptions, setProjectOptions] = useState<{ id: number; name: string }[]>([])
  // ?group= deep link mirrors ?project=, so the "+ Task" button on a working
  // group's page preselects that group. Routing only decides whose FEED shows it —
  // no permission, no money, not in the brief hash (see the API route).
  const [workingGroupId, setWorkingGroupId] = useState<number | null>(null)
  const [groupOptions, setGroupOptions] = useState<{ id: number; name: string }[]>([])
  // Deep-link defaults (if any) are applied by applyDeepLinks below, once
  // DeepLinkParamsReader resolves — plain empty state here, not a lazy
  // initializer, since the query string is no longer available synchronously
  // at this component's first render.
  const [terms, setTerms] = useState<TaskTerms>({})
  // Criteria edit as one-per-line text; parsed into terms on the fly.
  const [criteriaText, setCriteriaText] = useState("")
  // Legacy #143 ?template= deep-links map to a deliverable type's defaults.
  // All three deep-link params (template/project/group) are read by
  // DeepLinkParamsReader below and applied here, ONCE (the ref guards it —
  // bad ids are ignored, and a later URL change never overwrites user edits,
  // matching the old useState(() => ...) lazy-init semantics this replaced).
  const deepLinksApplied = useRef(false)
  const applyDeepLinks = useCallback((searchParams: URLSearchParams) => {
    if (deepLinksApplied.current) return
    deepLinksApplied.current = true
    const templateType = LEGACY_TEMPLATE_TYPES[searchParams.get("template") ?? ""]
    if (templateType) {
      const defaults = DELIVERABLE_DEFAULTS[templateType]
      setTerms((t) => ({ ...t, ...defaults }))
      setCriteriaText((defaults.acceptanceCriteria ?? []).join("\n"))
    }
    const p = Number(searchParams.get("project"))
    if (Number.isInteger(p) && p > 0) setProjectId(p)
    const g = Number(searchParams.get("group"))
    if (Number.isInteger(g) && g > 0) setWorkingGroupId(g)
  }, [])

  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/projects")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && body?.ok) setProjectOptions(body.data)
      })
      .catch(() => {}) // picker is optional sugar — a failed load just hides it
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    apiFetch("/api/v1/groups")
      .then((res) => res.json())
      .then((body) => {
        // The catalog returns only ACTIVE groups, which is the same set the API
        // route will accept — so the picker cannot offer an option the POST
        // would 404. Keep those two in step if either side changes.
        if (!cancelled && body?.ok) setGroupOptions(body.data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [created, setCreated] = useState<{
    id: string
    reward: number
    title: string
    description: string
    termsBlock: string
  } | null>(null)

  const setTerm = <K extends keyof TaskTerms>(key: K, value: TaskTerms[K]) =>
    setTerms((t) => ({ ...t, [key]: value }))

  // Picking a deliverable type merges that type's default terms (the soul of
  // the removed template gallery) — user edits freely afterwards.
  const selectType = (type: DeliverableType) => {
    const defaults = DELIVERABLE_DEFAULTS[type]
    setTerms((t) => ({ ...t, ...defaults }))
    setCriteriaText((defaults.acceptanceCriteria ?? []).join("\n"))
  }

  const parsedCriteria = criteriaText
    .split("\n")
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter((l) => l.length >= 3)
    .slice(0, 7)

  const buildTerms = (): TaskTerms | undefined => {
    const t: TaskTerms = { ...terms }
    if (parsedCriteria.length > 0) t.acceptanceCriteria = parsedCriteria
    else delete t.acceptanceCriteria
    // Drop empty-string url/contact fields so the strict server schema passes.
    if (!t.repoUrl) delete t.repoUrl
    if (!t.specUrl) delete t.specUrl
    if (!t.commChannel) delete t.commChannel
    if (!t.licenseNote) delete t.licenseNote
    if (t.definitionOfDone && t.definitionOfDone.length === 0) delete t.definitionOfDone
    return hasTerms(t) ? t : undefined
  }

  const toggleDoneCheck = (check: DoneCheck) => {
    const current = terms.definitionOfDone ?? []
    setTerm(
      "definitionOfDone",
      current.includes(check) ? current.filter((c) => c !== check) : [...current, check],
    )
  }

  const currentIdx = STEPS.findIndex((s) => s.id === step)
  // WHY the button is disabled, as data — so the page can never disable
  // Continue for a reason it does not also print (src/lib/create-task-blockers.ts).
  // The reward step blocks below MIN_REWARD_XRD — the escrow's own floor — so a
  // reward the chain would refuse to fund never becomes a task row.
  const blockers = createStepBlockers(step, { title, description, rewardXrd })
  const canAdvance = blockers.length === 0
  // A field reads as INVALID only once the poster has left it — the reason line
  // by the button is always there, but red-on-first-paint for a form nobody has
  // touched yet is noise. `aria-describedby` points at that line either way.
  const [touched, setTouched] = useState<Partial<Record<CreateBlockerField, boolean>>>({})
  const markTouched = (field: CreateBlockerField) => setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }))
  const invalidProps = (field: CreateBlockerField) =>
    isFieldBlocked(blockers, field)
      ? { "aria-describedby": CONTINUE_BLOCKER_ID, ...(touched[field] ? { "aria-invalid": true as const } : {}) }
      : {}

  // Step 3 (docs/design/github-reality-acceptance.md #3): a code/software task
  // defaults onto the GitHub-reality path. `definitionOfDone` already gets its
  // machine-verifiable checks from DELIVERABLE_DEFAULTS.code (ci-green,
  // code-reviewed) the moment the poster picks "Code" below — this only adds
  // the repoUrl field's "expected" treatment, since that part had no
  // category-aware behaviour at all before now. Read from the SAME
  // deliverableType field DELIVERABLE_DEFAULTS is keyed on — no new category
  // concept invented. Non-code categories are untouched.
  const isCodeCategory = terms.deliverableType === "code"
  const insuranceXrd = Math.ceil((Number(rewardXrd) || 0) * INSURANCE_RATE)
  const contractLines = renderContractSummary({
    rewardXrd: Number(rewardXrd) || 0,
    insuranceXrd,
    terms: buildTerms(),
    dueIso: deadline ? new Date(deadline).toISOString() : null,
    usdRate,
  })

  const handleSubmit = async () => {
    setIsSubmitting(true)
    setSubmitError(null)
    const finalTerms = buildTerms()
    const body: Record<string, unknown> = { title, description, reward_amount: rewardXrd }
    if (deadline) body.deadline = new Date(deadline).toISOString()
    if (finalTerms) body.terms = finalTerms
    if (projectId !== null) body.project_id = projectId
    if (workingGroupId !== null) body.working_group_id = workingGroupId
    try {
      const gate = await ensureSessionDetailed()
      if (!gate.ok) {
        setSubmitError(signInDidNotComplete("no task was posted", gate))
        return
      }
      const res = await apiFetch("/api/v1/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      // The escrow deposit hashes the STORED row (title/description/terms from
      // the POST response, falling back to the byte-identical form values) so
      // the on-chain commitment is verifiable against the DB later.
      const row = data.data
      const storedTerms = (row.terms ?? finalTerms ?? null) as TaskTerms | null
      const storedDeadline = typeof row.deadline === "string" ? row.deadline : deadline ? new Date(deadline).toISOString() : null
      setCreated({
        id: String(row.id),
        reward: parseFloat(rewardXrd) || 0,
        title: typeof row.title === "string" ? row.title : title,
        description: typeof row.description === "string" ? row.description : description,
        termsBlock: hasTerms(storedTerms) || storedDeadline
          ? canonicalTermsBlock(storedTerms, { dueIso: storedDeadline })
          : "",
      })
      setStep("done")
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Submission failed")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link href="/tasks" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to Tasks</Link>

      {/* ⚠️ This page had NO h1 — the only major route without one, and it is
          the poster-onboarding conversion surface. On a phone it was worse: the
          step labels were `hidden sm:inline`, so under 640px a visitor saw bare
          numbered circles and nothing anywhere said what page they were on. */}
      <h1 className="text-2xl font-bold">Post a task</h1>

      {/* Suspense boundary scoped to ONLY the useSearchParams() read (see
          DeepLinkParamsReader above) — this used to wrap the entire page,
          which meant fallback={null} rendered nothing at all, including this
          h1, until client JS hydrated. Renders nothing itself either way. */}
      <Suspense fallback={null}>
        <DeepLinkParamsReader onResolve={applyDeepLinks} />
      </Suspense>

      {postingFrozen === true && step !== "done" && (
        <PostingPausedNotice detail={POSTING_PAUSED_CREATE_DETAIL} />
      )}

      {step !== "done" && (
        <ol className="flex items-center gap-2" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2" aria-current={step === s.id ? "step" : undefined}>
              <div className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold border-2 transition-colors ${step === s.id ? "border-primary bg-primary text-primary-foreground" : currentIdx > i ? "border-green-500 bg-green-500 text-white" : "border-muted-foreground/30 text-muted-foreground"}`}>
                {currentIdx > i ? <Check className="h-3.5 w-3.5" aria-hidden /> : s.number}
              </div>
              {/* Shrunk on mobile, not hidden. */}
              <span className={`text-[11px] sm:text-xs font-medium ${step === s.id ? "text-foreground" : "text-muted-foreground"}`}>{s.label}</span>
              {i < STEPS.length - 1 && <div className="w-6 h-0.5 bg-border hidden sm:block" aria-hidden />}
            </li>
          ))}
        </ol>
      )}

      {step === "what" && (
        <Card><CardHeader><CardTitle>What needs doing?</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <span className="block text-sm font-medium leading-none">Deliverable type</span>
              <div role="group" aria-label="Deliverable type" className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {DELIVERABLE_TYPES.map((type) => (
                  <button key={type} type="button" onClick={() => selectType(type)} aria-pressed={terms.deliverableType === type}
                    className={`rounded-md border px-2.5 py-2 text-left transition-colors hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${terms.deliverableType === type ? "border-primary bg-primary/5" : "border-input"}`}>
                    <span className="block text-xs font-medium">{TYPE_LABELS[type].label}</span>
                    <span className="block text-[11px] text-muted-foreground leading-snug">{TYPE_LABELS[type].blurb}</span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">Picking a type prefills sensible delivery terms below — edit freely.</p>
            </div>
            <div className="space-y-2"><Label htmlFor="title">Title <span className="text-destructive">*</span></Label>
              <Input id="title" placeholder="e.g. Add ledger support to the wallet" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => markTouched("title")} {...invalidProps("title")} autoFocus />
              <p className="text-[11px] text-muted-foreground">Be specific — a clear title gets better responses.</p></div>
            <div className="space-y-2"><Label htmlFor="description">Description <span className="text-destructive">*</span></Label>
              <Textarea id="description" placeholder="Describe what you need, what good looks like, and any constraints..." value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => markTouched("description")} {...invalidProps("description")} rows={6} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="repo">Repository{isCodeCategory ? "" : " (optional)"}</Label>
                <Input id="repo" inputMode="url" placeholder="https://github.com/org/repo" value={terms.repoUrl ?? ""} onChange={(e) => setTerm("repoUrl", e.target.value || undefined)} />
                {/* Expected-not-required, per the design doc: a code task defaults
                    onto GitHub-reality acceptance (a merged PR verified against
                    this repo), but leaving it blank is a soft warning, never a
                    block — manual review still works for a code task with no
                    linked repo. */}
                <p className="text-[11px] text-muted-foreground">
                  {isCodeCategory
                    ? "Code tasks verify acceptance from a merged PR in this repo — add it so GitHub reality can check the work."
                    : "Link the repo the work should land in."}
                </p>
                {isCodeCategory && !terms.repoUrl && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
                    No repo linked yet — GitHub-reality verification won&apos;t have anything to check.
                  </p>
                )}
              </div>
              <div className="space-y-2"><Label htmlFor="spec">Issue / spec link (optional)</Label>
                <Input id="spec" inputMode="url" placeholder="https://github.com/org/repo/issues/42" value={terms.specUrl ?? ""} onChange={(e) => setTerm("specUrl", e.target.value || undefined)} /></div>
            </div>
            {(projectOptions.length > 0 || projectId !== null) && (
              <div className="space-y-2">
                <Label htmlFor="project">Project (optional)</Label>
                <select id="project" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  value={projectId ?? ""} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">No project</option>
                  {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <p className="text-[11px] text-muted-foreground">Group this task on a project board.</p>
              </div>
            )}

            {(groupOptions.length > 0 || workingGroupId !== null) && (
              <div className="space-y-1.5">
                <Label htmlFor="working-group">Working group (optional)</Label>
                <select id="working-group" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                  value={workingGroupId ?? ""} onChange={(e) => setWorkingGroupId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">No working group</option>
                  {groupOptions.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <p className="text-[11px] text-muted-foreground">Shows this task in that group&apos;s feed. Doesn&apos;t restrict who can claim.</p>
              </div>
            )}
          </CardContent></Card>)}

      {step === "reward" && (
        <Card><CardHeader><CardTitle>Reward & terms</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="reward">Reward (XRD) <span className="text-destructive">*</span></Label>
                {/* `min` is a browser HINT (spinner floor, :invalid styling) — it
                    enforces nothing, which is how "0.5" used to reach the chain.
                    The rule is createStepBlockers; this only mirrors its number. */}
                <Input id="reward" type="number" min={MIN_REWARD_XRD} step="1" placeholder="500" value={rewardXrd} onChange={(e) => setRewardXrd(e.target.value)} onBlur={() => markTouched("reward")} {...invalidProps("reward")} autoFocus />
                <p className="text-[11px] text-muted-foreground"><LayerChip enforced /> Locked in escrow with +{INSURANCE_RATE * 100}% insurance{Number(rewardXrd) > 0 ? ` (${insuranceXrd} XRD)` : ""} when you fund the task — a second wallet transaction after posting.</p>
                {Number(rewardXrd) > 0 && (
                  <p className="text-[11px]">
                    <span className="text-muted-foreground">Total locked at funding: </span>
                    <XrdAmount
                      amountXrd={Number(rewardXrd) + insuranceXrd}
                      usdRate={usdRate}
                      stale={usdStale}
                      ageSeconds={usdAgeSeconds}
                      source={usdSource}
                      className="font-medium"
                    />
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="deadline">Due date (optional)</Label>
                {/* min=today: the field accepted a past date, and the Review
                    step then printed "Work is due <yesterday>" on a task that
                    was created already overdue. The value is committed into the
                    on-chain brief, so this is cheaper to prevent than to
                    explain afterwards. Client-side only — the brief records
                    whatever is submitted, so this is a guard rail, not a gate. */}
                <Input id="deadline" type="date" min={new Date().toISOString().slice(0, 10)}
                  value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                <p className="text-[11px] text-muted-foreground"><LayerChip /> Committed into the on-chain brief.</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="criteria">Acceptance criteria — one per line (max 7)</Label>
              <Textarea id="criteria" rows={4} placeholder={"PR opened against the linked repo\nAll existing tests stay green"} value={criteriaText} onChange={(e) => setCriteriaText(e.target.value)} />
              <p className="text-[11px] text-muted-foreground"><LayerChip /> Testable statements — the surest way to avoid a dispute.</p>
            </div>

            <div className="space-y-2">
              <span className="block text-sm font-medium leading-none">Done means</span>
              <div className="flex flex-wrap gap-2">
                {DONE_CHECKS.map((check) => {
                  const on = terms.definitionOfDone?.includes(check) ?? false
                  return (
                    <button key={check} type="button" onClick={() => toggleDoneCheck(check)} aria-pressed={on}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-primary bg-primary/10 text-foreground" : "border-input text-muted-foreground hover:border-primary/60"}`}>
                      {DONE_CHECK_LABELS[check]}
                    </button>
                  )
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">Objective gates the deliverable must clear — pick the ones a reviewer can verify at a glance.</p>
            </div>

            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label htmlFor="review-window">Review within (days)</Label>
                {/* ⚠️ placeholder is "Not set", NOT "3" — and the clamp runs on
                    BLUR, not on every keystroke. Both were reported on
                    2026-09-16 as "the default values 3 and 1 cannot be
                    cleared", and the reporter was describing two real things
                    even though the diagnosis was wrong (the fields were empty;
                    3 and 1 were placeholder text):
                      • a bare numeric placeholder is indistinguishable from a
                        value at a glance, and clearing the field made "3"
                        reappear instantly — which reads exactly like the field
                        snapping back to a default it was refusing to let go of;
                      • Math.max(1, …) inside onChange rewrote the field ON EACH
                        KEYSTROKE, so typing "0" as the first character of "05"
                        silently became "1" under the cursor.
                    Blank here means UNSPECIFIED, not 3: canonicalTermsBlock
                    omits unset keys, so no phantom default ever reaches the
                    hashed on-chain brief. Picking a deliverable type is what
                    fills these in (DELIVERABLE_DEFAULTS) — as a real value the
                    poster can see and edit. */}
                <Input id="review-window" type="number" min="1" max="30" value={terms.reviewWindowDays ?? ""} placeholder="Not set"
                  onChange={(e) => setTerm("reviewWindowDays", e.target.value ? Number(e.target.value) : undefined)}
                  onBlur={(e) => { const v = e.target.value; if (v) setTerm("reviewWindowDays", Math.max(1, Math.min(30, Number(v)))) }} />
                <p className="text-[11px] text-muted-foreground">Your promise to review a submission within this many days. It is committed into the on-chain brief as evidence — the escrow does not enforce that number, but it does enforce its own 3-day review window: after that, anyone may trigger a release for the full reward without your approval.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="revisions">Revisions included</Label>
                {/* Same two fixes as Review within — see the note above. */}
                <Input id="revisions" type="number" min="0" max="3" value={terms.revisionsIncluded ?? ""} placeholder="Not set"
                  onChange={(e) => setTerm("revisionsIncluded", e.target.value ? Number(e.target.value) : undefined)}
                  onBlur={(e) => { const v = e.target.value; if (v) setTerm("revisionsIncluded", Math.max(0, Math.min(3, Number(v)))) }} />
                <p className="text-[11px] text-muted-foreground">Rounds of changes included before extra scope is renegotiated.</p>
              </div>
              <div className="space-y-2">
                <Label>Who can claim</Label>
                <div className="flex gap-1">
                  {(["both", "humans", "agents"] as const).map((who) => (
                    <button key={who} type="button" onClick={() => setTerm("claimEligibility", who)} aria-pressed={(terms.claimEligibility ?? "both") === who}
                      className={`flex-1 rounded-md border px-1 py-1.5 text-[11px] capitalize transition-colors ${(terms.claimEligibility ?? "both") === who ? "border-primary bg-primary/10" : "border-input text-muted-foreground"}`}>
                      {who}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground"><LayerChip /> States who the task is meant for and is committed into the on-chain brief. Not enforced today — any badge-holding claimer can still claim.</p>
                {terms.claimEligibility === "agents" && (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Agents work Guild tasks today with a Guild Member badge — claim, submit, and collect their reward from the same escrow once the poster approves it (proven end-to-end on mainnet). The dedicated agent-badge lane is still in pilot.</p>
                )}
              </div>
            </div>

            <details className="rounded-md border border-input px-3 py-2">
              <summary className="cursor-pointer select-none text-sm font-medium">More terms (license, contact)</summary>
              {/* ⚠️ The "Min trust to claim" select was REMOVED 2026-08-29 (operator
                  ruling). It offered a gate with specific criteria — "Established+
                  (5 paid tasks, no disputes)", "Top Rated only (15 paid, 95%
                  on-time)" — and was enforced by a client-side `if` in the claim
                  button, which anyone calling `claim_task` directly ignores. For an
                  audience that reads code, an access control that lives only in the
                  React tree is worse than no access control: it misleads the poster
                  who sets it. Enforcing it on-chain would need a reputation source
                  that does not exist.
                  The `minTrustTier` FIELD stays in TaskTermsSchema and in
                  canonicalTermsBlock — the terms block is hashed and committed
                  on-chain, and its format is FROZEN, so removing a key would change
                  the hash of every existing task and break dispute evidence. It is
                  simply no longer offered or enforced. A poster who wants
                  experienced builders says so in the brief. */}
              <div className="grid sm:grid-cols-2 gap-3 pt-3">
                <div className="space-y-2">
                  <Label htmlFor="license">License / IP</Label>
                  <select id="license" className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    value={terms.license ?? ""} onChange={(e) => setTerm("license", (e.target.value || undefined) as TaskTerms["license"])}>
                    <option value="">Not specified</option>
                    {LICENSES.map((l) => <option key={l} value={l}>{LICENSE_LABELS[l]}</option>)}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="contact">Contact while working</Label>
                  <Input id="contact" placeholder="@handle on TG, or the GH issue thread" value={terms.commChannel ?? ""} onChange={(e) => setTerm("commChannel", e.target.value || undefined)} />
                </div>
                {terms.license === "custom" && (
                  <div className="space-y-2 sm:col-span-2">
                    <Label htmlFor="license-note">License note</Label>
                    <Input id="license-note" placeholder="Describe the custom license terms" value={terms.licenseNote ?? ""} onChange={(e) => setTerm("licenseNote", e.target.value || undefined)} />
                  </div>
                )}
              </div>
            </details>
          </CardContent></Card>)}

      {step === "review" && (
        <Card><CardHeader><CardTitle>Review your task</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-4 space-y-3">
              <div className="flex items-center gap-2"><h3 className="font-semibold">{title || "Untitled"}</h3>
                <Badge variant="secondary" className="bg-green-500/10 text-green-500 text-[10px]">open</Badge>
                {terms.deliverableType && <Badge variant="secondary" className="text-[10px] capitalize">{terms.deliverableType}</Badge>}
                {projectId !== null && projectOptions.some((p) => p.id === projectId) && (
                  <Badge variant="secondary" className="text-[10px]">{projectOptions.find((p) => p.id === projectId)!.name}</Badge>
                )}</div>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{description || "No description."}</p>
              {parsedCriteria.length > 0 && (
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-0.5">
                  {parsedCriteria.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              )}
            </div>
            <div className="rounded-md bg-muted px-3 py-2 space-y-1">
              <p className="text-xs font-medium">The contract</p>
              {contractLines.map((line, i) => (
                <p key={i} className="text-[11px] text-muted-foreground">{line}</p>
              ))}
            </div>
          </CardContent></Card>)}

      {step === "done" && created && (
        <Card><CardHeader><CardTitle>Task posted</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-green-600"><Check className="h-5 w-5" /><span className="font-medium">Task created successfully</span></div>
            <p className="text-sm text-muted-foreground">Your task is already on the board — but nobody can claim it until you fund it, and unfunded tasks drop off the public board after 24 hours. Funding is a second wallet transaction: it locks the reward + insurance in escrow and commits the brief and its terms on-chain. The escrow releases the reward when you approve the work — or, if you neither approve nor dispute within 3 days of a submission, anyone can release the full reward.</p>
            <EscrowDisabledNotice />
            <EscrowDepositButton taskId={created.id} rewardXrd={created.reward} title={created.title} description={created.description} termsBlock={created.termsBlock} onSuccess={() => router.push(`/tasks/${created.id}`)} />
            <div className="text-center"><Link href={`/tasks/${created.id}`} className="text-xs text-muted-foreground underline">Skip for now — fund later</Link></div>
          </CardContent></Card>)}

      {submitError && <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{submitError}</div>}

      {step !== "done" && (
        <div className="space-y-2">
          <div className="flex justify-between">
            {step !== "what" ? <Button variant="outline" onClick={() => setStep(STEPS[currentIdx - 1].id)}>Back</Button> : <div />}
            {step !== "review" ? <Button onClick={() => setStep(STEPS[currentIdx + 1].id)} disabled={!canAdvance}>Continue <ArrowRight className="ml-2 h-4 w-4" /></Button>
            : <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? "Posting…" : "Post Task"}</Button>}
          </div>
          {/* A disabled button that does not say why is a dead button (stranger
              walkthrough 2026-09-17: "Continue with an empty Reward does nothing
              visible"). `role="status"` because a disabled button is not
              focusable, so `aria-describedby` on it would never be read out —
              the live region is what tells a screen-reader user what is missing.
              Always rendered while the step is live so the region exists BEFORE
              its text changes; an empty live region announces nothing. */}
          <div className="flex items-baseline justify-end gap-2 min-h-[1rem]">
            <p id={CONTINUE_BLOCKER_ID} role="status" className="text-right text-[11px] text-muted-foreground">
              {blockers.length > 0 ? `To continue: ${blockers.map((b) => b.message).join(" ")}` : ""}
            </p>
            {/* Step 2 is a screen and a half tall: the Reward field is out of
                sight by the time the poster reaches this button (seen live,
                2026-09-17). Naming the field is half an answer; taking them to
                it is the other half. The blocker's `field` IS the input's id.
                OUTSIDE the status region on purpose — a control inside a live
                region gets re-announced with every text change. */}
            {blockers.length > 0 && (
              <button
                type="button"
                className="shrink-0 text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                onClick={() => {
                  const first = blockers[0].field
                  markTouched(first)
                  document.getElementById(first)?.focus()
                }}
              >
                Show me
              </button>
            )}
          </div>
        </div>)}
    </div>
  )
}

export default function CreateTaskPage() {
  // No Suspense here any more: useSearchParams only requires a boundary
  // around the component that actually calls it (DeepLinkParamsReader,
  // isolated above), not around everything that happens to render alongside
  // it. Wrapping the whole page meant fallback={null} produced a blank
  // document — including the unconditional <h1> — for anything that fetches
  // this route without executing JS (a crawler, a "view source", a client
  // with JS disabled). CreateTaskContent itself has no dynamic APIs, so it
  // now server-renders normally.
  return <AppShell><CreateTaskContent /></AppShell>
}
