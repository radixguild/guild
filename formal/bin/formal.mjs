#!/usr/bin/env node
// formal.mjs — the fleet's Quint + Apalache harness.
//
// Zero dependencies. Node >= 18. Vendored per repo under formal/bin/.
//
// WHY THIS EXISTS, in one line: a model that cannot fail proves nothing, and a
// model that no longer describes the code proves nothing about the code. This
// runner enforces both — every model must carry a mutation manifest whose
// mutations are asserted to FAIL, and a grounding hash over the source it
// claims to describe.
//
// Commands:
//   formal check            full gate: versions, drift, typecheck, run, verify, mutations
//   formal quick            typecheck + simulate only (seconds; pre-commit tier)
//   formal verify [model]   Apalache only
//   formal mutate [model]   mutation proof only
//   formal ground <model>   re-stamp the grounding hash after a DELIBERATE re-grounding
//   formal report           write formal/REPORT.md from the last check
//
// Exit codes: 0 pass · 1 a check failed · 2 harness/config error.

import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// Tiers exist because Apalache cost is wildly uneven. Most models verify in
// seconds; hyperscale's spc_views_ok documents ~6h and ~8h for two individual
// invariants. A single gate that runs everything is a gate nobody can put on a PR.
//   fast  — default. Per-PR. Seconds to a couple of minutes.
//   slow  — scheduled or on demand. Hours. Never blocks a PR.
const TIER = (process.env.FORMAL_TIER || 'fast').toLowerCase()

// ── tiny output helpers ───────────────────────────────────────────────────────
const C = process.stdout.isTTY && !process.env.NO_COLOR
const c = (n, s) => (C ? `\x1b[${n}m${s}\x1b[0m` : s)
const red = s => c(31, s), green = s => c(32, s), yellow = s => c(33, s), dim = s => c(2, s), bold = s => c(1, s)
const PASS = green('✅'), FAIL = red('🔴'), WARN = yellow('⚠️ ')

const results = []
let failed = false
function record(kind, name, ok, detail) {
  results.push({ kind, name, ok, detail })
  if (!ok) failed = true
  console.log(`${ok ? PASS : FAIL} ${dim(kind.padEnd(9))} ${name}${detail ? '  ' + dim(detail) : ''}`)
}

// For an inverted check (a mutation/twin that MUST fail), a timeout or a crashed
// checker is not "detected" — it is no answer at all. Route every inverted check
// through here so a broken run can never be scored as a passing mutation proof.
//
// Read quint's OWN verdict markers rather than guessing at error strings. An earlier
// version pattern-matched phrases like "Apalache server" to detect a dead checker —
// but quint prints that phrase during a perfectly normal run, so real counterexamples
// were being reported as inconclusive. A detector that fires on success is worse than
// no detector. The markers below are what quint actually emits for a decided run;
// anything else genuinely is no answer.
function verdict(r) {
  const out = r.out || ''
  if (/\[violation\]/.test(out) || /error: found a counterexample/.test(out)) return { kind: 'violated' }
  if (/\[ok\] No violation found/.test(out)) return { kind: 'held' }
  if (r.timedOut) return { kind: 'inconclusive', why: 'TIMED OUT — no verdict, not a pass' }
  return { kind: 'inconclusive', why: 'NO VERDICT from quint (crash, dead JVM, or bad args) — not a pass: ' + firstError(out) }
}

// The directory is `formal/` in repos adopting this fresh, and `specs/` where a
// convention already exists (hyperscale-rs). Models sit either in `<root>/models/`
// or directly in `<root>/`. Both shapes are supported so no repo is asked to rename
// an established layout just to get a gate.
const ROOT_NAMES = ['formal', 'specs']
function hasManifests(d) {
  return fs.existsSync(d) && fs.readdirSync(d).some(f => f.endsWith('.mutations.json'))
}
function findFormalRoot() {
  let d = process.cwd()
  for (let i = 0; i < 8; i++) {
    if (ROOT_NAMES.includes(path.basename(d)) && (hasManifests(path.join(d, 'models')) || hasManifests(d))) return d
    for (const n of ROOT_NAMES) {
      const c = path.join(d, n)
      if (hasManifests(path.join(c, 'models')) || hasManifests(c)) return c
    }
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  die(`no ${ROOT_NAMES.join('/ or ')}/ directory with *.mutations.json found from ` + process.cwd())
}

const ROOT = findFormalRoot()
const MODELS = hasManifests(path.join(ROOT, 'models')) ? path.join(ROOT, 'models') : ROOT
const LOCK = path.join(ROOT, 'quint.lock.json')

function die(msg) { console.error(red('formal: ') + msg); process.exit(2) }

// ── quint invocation ──────────────────────────────────────────────────────────
// Returns {ok, out}. ok===true means quint exited 0 (no violation / typechecks).
// Apalache runs as a server at localhost:8822 by default, and the shared JVM's
// lifetime is tied to the process tree that spawned it — a sibling's exit can drop
// every in-flight check. Give each verify its own port. (Documented in
// hyperscale-rs/specs/README.md, learned the hard way there.)
let PORT = 8822
const nextPort = () => ++PORT
let APALACHE_PIN = null   // set from quint.lock.json before any verify runs

// `quint run` defaults to a Rust evaluator that quint DOWNLOADS FROM GITHUB on first
// use, unauthenticated. On a CI runner with a cold ~/.quint that is a network call
// subject to GitHub's anonymous rate limit — it failed one repo's first run and not
// the other's, from the same commit. A simulation tier that flakes on someone else's
// rate limit is not a gate.
//
// So: keep the fast backend locally, and fall back to the bundled TypeScript
// evaluator when the fetch fails, saying so. The simulator is the cheap smoke tier
// here; Apalache is the tier that decides anything, and it does not use this.
const FETCH_FAILED = /Failed to fetch from GitHub|ENOTFOUND|rate limit/i

function quint(args, opts = {}) {
  const r = quintOnce(args, opts)
  if (args[0] === 'run' && !r.ok && FETCH_FAILED.test(r.out || '') && !args.includes('--backend=typescript')) {
    // The TypeScript evaluator is ~140x slower than the Rust one (measured: 4m42s vs
    // ~2s at 30k samples on the escrow model), so falling back at the same sample
    // count would hang the job rather than degrade it. Cap the budget hard: this is a
    // smoke test rescuing itself, not the same check by other means.
    const capped = args.map(a => a.startsWith('--max-samples=') ? '--max-samples=300' : a)
    console.log(`${WARN} ${dim('backend'.padEnd(9))} rust evaluator unavailable (GitHub fetch failed) ${dim('— falling back to TypeScript at 300 samples, a WEAKER check')}`)
    return quintOnce([...capped, '--backend=typescript'], { ...opts, timeoutMs: 180_000 })
  }
  return r
}

const DEFAULT_TIMEOUT_MS = TIER === 'fast' ? 10 * 60_000 : 4 * 60 * 60_000

function quintOnce(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (args[0] === 'verify') {
    args = [...args, `--server-endpoint=localhost:${nextPort()}`]
    // Pin the checker AT INVOCATION. Comparing ~/.quint afterwards is not a pin — on
    // a cold CI runner the directory is empty until the first verify fetches Apalache,
    // so a post-hoc comparison fails a run in which nothing is actually wrong.
    if (APALACHE_PIN) args = [...args, `--apalache-version=${APALACHE_PIN}`]
  }
  try {
    const out = execFileSync('quint', args, {
      encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
      env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out }
  } catch (e) {
    if (e.code === 'ENOENT') die('quint not found on PATH. `npm install -g @informalsystems/quint@<pinned>`')
    if (e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
      return { ok: false, timedOut: true, out: (e.stdout || '') + '\n[TIMEOUT]' }
    }
    return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// ── config ────────────────────────────────────────────────────────────────────
function readLock() {
  if (!fs.existsSync(LOCK)) die(`missing ${rel(LOCK)} — run \`formal ground\` on a model first, or copy the template`)
  return JSON.parse(fs.readFileSync(LOCK, 'utf8'))
}
const rel = p => path.relative(path.dirname(ROOT), p)
// A file may hold several modules (a healthy instance plus its twins). `main`
// names the one the top-level checks run against; quint otherwise guesses from
// the filename, which picks the parameterised base module and fails on unbound consts.
const mainArgs = m => (m.main ? [`--main=${m.main}`] : [])

// A .qnt file may declare many instances of one base module — a healthy one plus
// several deliberately-broken twins, each with its own invariants and its own
// verification depth. `instances` is the general form; a manifest with a bare
// `main`/`verify` is treated as a single instance so simple models stay simple.
function instancesOf(m) {
  if (Array.isArray(m.instances) && m.instances.length) return m.instances
  return [{
    main: m.main,
    invariants: m.verify?.invariants?.length ? m.verify.invariants
              : [m.verify?.invariant || 'allSafety'],
    maxSteps: m.verify?.maxSteps ?? 12,
    tier: m.verify?.tier || 'fast',
  }]
}
const inTier = t => TIER === 'all' || (t || 'fast') === TIER

function manifests() {
  if (!fs.existsSync(MODELS)) die(`missing ${rel(MODELS)}`)
  const ms = fs.readdirSync(MODELS).filter(f => f.endsWith('.mutations.json')).sort()
  // Every model must be declared. An undeclared .qnt sitting beside declared ones is
  // a model nothing gates — exactly the state this harness exists to end.
  const declared = new Set(ms.map(f => f.replace('.mutations.json', '.qnt')))
  for (const f of fs.readdirSync(MODELS).filter(f => f.endsWith('.qnt'))) {
    if (!declared.has(f)) console.log(`${WARN} ${dim('undeclared'.padEnd(9))} ${f} ${dim('— no .mutations.json, so nothing gates it')}`)
  }
  if (!ms.length) die(`no *.mutations.json in ${rel(MODELS)} — every model must declare its mutations`)
  return ms.map(f => {
    const m = JSON.parse(fs.readFileSync(path.join(MODELS, f), 'utf8'))
    m.__file = f
    m.__path = path.join(MODELS, m.model)
    if (!fs.existsSync(m.__path)) die(`${f} names model "${m.model}" which does not exist`)
    return m
  })
}
const only = argv => {
  const a = argv.find(x => !x.startsWith('-'))
  return a ? ms => ms.filter(m => m.model === a || m.model === a + '.qnt' || m.__file.startsWith(a)) : ms => ms
}

// ── 1. version pinning ────────────────────────────────────────────────────────
// A verification result is meaningless without the checker version that produced
// it, so drift is a hard failure rather than a warning.
function detectVersions() {
  const q = quint(['--version'])
  const quintV = q.ok ? q.out.trim().split('\n').pop().trim() : 'UNKNOWN'
  let apalacheV = 'not-fetched'
  const home = path.join(process.env.HOME || '', '.quint')
  if (fs.existsSync(home)) {
    const d = fs.readdirSync(home).find(x => x.startsWith('apalache-dist-'))
    if (d) apalacheV = d.replace('apalache-dist-', '')
  }
  let jdk = 'none'
  try {
    jdk = execSync('java -version 2>&1', { encoding: 'utf8' }).split('\n')[0]
      .replace(/.*version "?([0-9._]+)"?.*/, '$1').trim()
  } catch { /* no jvm */ }
  return { quint: quintV, apalache: apalacheV, jdk }
}

function checkVersions(lock) {
  const got = detectVersions()
  const want = lock.tools || {}
  let ok = true
  APALACHE_PIN = want.apalache || null
  // Quint is installed by the caller, so the only thing to do is compare and fail.
  if (want.quint && want.quint !== got.quint) {
    record('versions', `quint ${got.quint} != pinned ${want.quint}`, false,
      'results are not comparable across checker versions — re-pin deliberately')
    ok = false
  }
  // Apalache is fetched on demand and PINNED at invocation above, so a not-yet-fetched
  // distribution is normal on a cold runner, not a failure. An already-fetched one that
  // disagrees with the pin is worth saying out loud, but the pin still wins per-call.
  if (want.apalache && got.apalache !== 'not-fetched' && want.apalache !== got.apalache) {
    console.log(`${WARN} ${dim('versions'.padEnd(9))} ~/.quint holds apalache ${got.apalache}, pin is ${want.apalache} ${dim('— each verify requests the pin explicitly')}`)
  }
  if (got.jdk === 'none') {
    record('versions', 'no JVM — Apalache cannot run', false, 'brew install openjdk@17; export JAVA_HOME=/usr/local/opt/openjdk@17')
    ok = false
  }
  if (ok) record('versions', `quint ${got.quint} · apalache ${got.apalache} · jdk ${got.jdk}`, true)
  return got
}

// ── 2. grounding-drift check ──────────────────────────────────────────────────
// The cheapest honest approximation of "the model still describes the code".
// It does NOT prove agreement. It proves the code has not changed since a human
// last asserted agreement — which is the only part a machine can check.
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16)
}
function groundsFor(m) {
  const g = m.grounds
  // An explicit, declared alternative. hyperscale's specs/ cite implementing code
  // per TRANSITION in comments rather than tracking whole files, so a whole-file hash
  // is the wrong instrument there. Declaring the mechanism is required; leaving
  // grounding undeclared is not.
  if (g && g.mechanism && (!Array.isArray(g.sources) || !g.sources.length)) {
    return { skip: true, declared: g.mechanism }
  }
  if (!g || !Array.isArray(g.sources) || !g.sources.length) {
    return { skip: true, reason: 'no grounds.sources declared' }
  }
  const repoRoot = path.dirname(ROOT)
  const drifted = []
  for (const s of g.sources) {
    const p = path.join(repoRoot, s.path)
    if (!fs.existsSync(p)) { drifted.push(`${s.path} MISSING`); continue }
    const now = sha256(p)
    if (now !== s.sha256) drifted.push(`${s.path} ${s.sha256}→${now}`)
  }
  return { skip: false, drifted, g }
}

function checkDrift(m) {
  const r = groundsFor(m)
  if (r.skip) {
    if (r.declared) {
      console.log(`${WARN} ${dim('grounding'.padEnd(9))} ${m.model} ${dim(`— no file-hash check; mechanism: ${r.declared}`)}`)
      results.push({ kind: 'grounding', name: `${m.model} (${r.declared})`, ok: true,
        detail: 'NOT hash-checked — drift is caught by the declared mechanism, or not at all' })
      return
    }
    record('grounding', `${m.model} — ${r.reason}`, false,
      'a model with no declared grounding cannot be cited about real code')
    return
  }
  if (r.drifted.length) {
    record('grounding', `${m.model} DRIFTED from its source`, false,
      r.drifted.join(' · ') + ' — re-read the code, update the model, then `formal ground ' + m.model + '`')
  } else {
    record('grounding', `${m.model} ← ${r.g.sources.map(s => s.path).join(', ')}`, true,
      `asserted ${r.g.verified}${r.g.describes ? ' · ' + r.g.describes : ''}`)
  }
}

// ── 3/4. typecheck, simulate, verify ──────────────────────────────────────────
function typecheck(m) {
  const r = quint(['typecheck', m.__path], { timeoutMs: 120_000 })
  record('typecheck', m.model, r.ok, r.ok ? '' : firstError(r.out))
  return r.ok
}

function simulate(m) {
  if (m.simulate === false || m.simulate?.skip) {
    console.log(`${dim('   skip'.padEnd(12))} simulate ${m.model} ${dim('— declared not useful for this model')}`)
    return true
  }
  const inv = m.simulate?.invariant || m.verify?.invariant
    || (m.instances && m.instances[0]?.invariants?.[0]) || 'allSafety'
  const r = quint(['run', m.__path, ...mainArgs(m), `--invariant=${inv}`,
    `--max-steps=${m.simulate?.maxSteps ?? 20}`,
    `--max-samples=${m.simulate?.maxSamples ?? 20000}`], { timeoutMs: (m.simulate?.timeoutSec ?? 300) * 1000 })
  record('simulate', `${m.model} ${inv}`, r.ok, r.ok ? dim('no violation') : firstError(r.out))
  return r.ok
}

function verifyOne(m, inv, maxSteps) {
  const t0 = Date.now()
  const r = quint(['verify', m.__path, ...mainArgs(m), `--invariant=${inv}`, `--max-steps=${maxSteps}`])
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  record('verify', `${m.model} ${inv} ≤${maxSteps} steps`, r.ok,
    r.ok ? dim(`holds · ${secs}s`) : firstError(r.out))
  return r.ok
}

function verify(m) {
  let ok = true
  for (const inst of instancesOf(m)) {
    if (!inTier(inst.tier)) {
      console.log(`${dim('   skip'.padEnd(12))} ${inst.main || m.model} [${inst.tier}] ${dim('— not in tier ' + TIER)}`)
      continue
    }
    ok = verifyInstance(m, inst) && ok
  }
  return ok
}

function verifyInstance(m, inst) {
  const maxSteps = inst.maxSteps ?? 12
  const invs = inst.invariants
  const label = inst.main ? `${m.model}::${inst.main}` : m.model
  const mArgs = inst.main ? [`--main=${inst.main}`] : mainArgs(m)
  // DEFAULT: one Apalache run over all invariants via --invariants, which reports
  // WHICH ones were violated. A conjunction (allSafety) does not — it hides which
  // conjunct did the work when it passes and which broke when it fails, so name the
  // invariants individually here even though they run together.
  // Some models MUST be checked one invariant per solver run — hyperscale's
  // spc_views_ok documents that combining its three into invAll exhausts the JVM.
  if (inst.individually || m.verify?.individually) {
    let ok = true
    for (const inv of invs) {
      const t0 = Date.now()
      const r = quint(['verify', m.__path, ...mArgs, `--invariant=${inv}`, `--max-steps=${maxSteps}`])
      const secs = ((Date.now() - t0) / 1000).toFixed(0)
      record('verify', `${label} ${inv} \u2264${maxSteps}`, r.ok, r.ok ? dim(`holds \u00b7 ${secs}s`) : firstError(r.out))
      ok = r.ok && ok
    }
    return ok
  }
  const t0 = Date.now()
  const r = quint(['verify', m.__path, ...mArgs, '--invariants', ...invs, `--max-steps=${maxSteps}`])
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  record('verify', `${label} [${invs.length} inv] \u2264${maxSteps} steps`, r.ok,
    r.ok ? dim(`all hold \u00b7 ${secs}s \u00b7 ${invs.join(' ')}`) : firstError(r.out))
  return r.ok
}

// ── 5. the mutation proof — the gate that actually matters ────────────────────
function applyMutation(src, mut) {
  const ops = mut.apply ? [mut.apply] : mut.applyAll
  if (!ops || !ops.length) die(`mutation "${mut.id}" has no apply/applyAll`)
  let out = src
  for (const op of ops) {
    const before = out
    if (op.type === 'delete-line') {
      out = out.split('\n').filter(l => !l.includes(op.match)).join('\n')
    } else if (op.type === 'replace') {
      if (!out.includes(op.from)) return { out, applied: false, op }
      out = op.all ? out.split(op.from).join(op.to) : out.replace(op.from, op.to)
    } else {
      die(`mutation "${mut.id}" has unknown apply type "${op.type}"`)
    }
    if (out === before) return { out, applied: false, op }
  }
  return { out, applied: true }
}

// A "twin" is a deliberately-broken module living in the same .qnt file, selected
// with --main. It is hyperscale-rs/specs' convention and it is stronger than a patch
// for complex models: the twin typechecks, so it cannot rot into a no-op patch.
// A "patch" edits the healthy model in place. It is stronger for guard-shaped bugs:
// it proves THIS model's guard is load-bearing, which is exactly the check that
// caught a dead guard in the first trade-lifecycle draft. Use both.
function runTwin(m, mut) {
  let allOk = true
  for (const inv of [].concat(mut.mustViolate)) {
    const engine = mut.engine === 'run' ? 'run' : 'verify'
    const args = engine === 'verify'
      ? ['verify', m.__path, `--main=${mut.twin}`, `--invariant=${inv}`, `--max-steps=${mut.maxSteps ?? m.verify?.maxSteps ?? 12}`]
      : ['run', m.__path, `--main=${mut.twin}`, `--invariant=${inv}`, `--max-steps=${mut.maxSteps ?? 25}`, `--max-samples=${mut.maxSamples ?? 20000}`]
    const v = verdict(quint(args))
    if (v.kind === 'inconclusive') {
      record('mutation', `${mut.id} (twin ${mut.twin}) \u2192 ${inv}`, false, v.why); allOk = false; continue
    }
    const detected = v.kind === 'violated'
    record('mutation', `${mut.id} (twin ${mut.twin}) \u2192 ${inv}`, detected,
      detected ? dim(`detected via ${engine}${mut.describes ? ' \u00b7 ' + mut.describes : ''}`)
               : red('NOT DETECTED \u2014 the twin is not actually broken, or the invariant cannot see it'))
    if (!detected) allOk = false
  }
  return allOk
}

function mutate(m) {
  const muts = m.mutations || []
  if (!muts.length) {
    record('mutation', `${m.model} declares NO mutations`, false,
      'an unmutated model is untested — a clean run says nothing')
    return false
  }
  const src = fs.readFileSync(m.__path, 'utf8')
  const tmp = m.__path.replace(/\.qnt$/, '.__mut.qnt')
  let allOk = true
  for (const mut of muts) {
    if (!inTier(mut.tier)) { console.log(`${dim('   skip'.padEnd(12))} ${mut.id} ${dim('[' + (mut.tier||'fast') + ']')}`); continue }
    if (mut.twin) { if (!runTwin(m, mut)) allOk = false; continue }
    const { out, applied, op } = applyMutation(src, mut)
    if (!applied) {
      record('mutation', `${mut.id} — PATCH DID NOT APPLY`, false,
        `the model no longer contains what this mutation targets: ${JSON.stringify(op).slice(0, 120)}`)
      allOk = false
      continue
    }
    fs.writeFileSync(tmp, out)
    try {
      const invs = [].concat(mut.mustViolate)
      for (const inv of invs) {
        const engine = mut.engine === 'verify' ? 'verify' : 'run'
        const args = engine === 'verify'
          ? ['verify', tmp, ...mainArgs(m), `--invariant=${inv}`, `--max-steps=${mut.maxSteps ?? m.verify?.maxSteps ?? 12}`]
          : ['run', tmp, ...mainArgs(m), `--invariant=${inv}`, `--max-steps=${mut.maxSteps ?? 25}`, `--max-samples=${mut.maxSamples ?? 20000}`]
        const r = quint(args)
        // INVERTED: the mutation MUST produce a violation. quint exits non-zero on violation.
        const detected = !r.ok
        record('mutation', `${mut.id} → ${inv}`, detected,
          detected ? dim(`detected via ${engine}${mut.describes ? ' · ' + mut.describes : ''}`)
                   : red('NOT DETECTED — this model cannot see the bug it was written for'))
        if (!detected) allOk = false
      }
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    }
  }
  return allOk
}

// A finding we have accepted and not yet fixed. The runner asserts it STILL
// violates. That is not a red X — it is a tracked open finding. If it stops
// violating, THAT is the failure: either the code was fixed (verify, then delete
// the entry) or someone loosened the invariant until it passed, which is the
// failure mode this exists to catch.
function knownOpen(m) {
  const items = m.knownOpen || []
  let ok = true
  for (const k of items) {
    if (!inTier(k.tier)) continue
    const args = [k.engine === 'verify' ? 'verify' : 'run', m.__path, ...(k.main ? [] : mainArgs(m)), `--invariant=${k.invariant}`,
      `--max-steps=${k.maxSteps ?? 25}`, `--max-samples=${k.maxSamples ?? 20000}`]
    if (k.main) args.splice(2, 0, `--main=${k.main}`)
    if (k.engine === 'verify') { const i = args.findIndex(a => a.startsWith('--max-samples')); if (i >= 0) args.splice(i, 1) }
    const v = verdict(quint(args))
    if (v.kind === 'inconclusive') { record('open', `${k.id} \u2192 ${k.invariant}`, false, v.why); ok = false; continue }
    const stillOpen = v.kind === 'violated'
    if (stillOpen) {
      console.log(`${WARN} ${dim('open'.padEnd(9))} ${k.id} \u2192 ${k.invariant}  ${dim(`still open since ${k.since ?? '?'}${k.describes ? ' \u00b7 ' + k.describes : ''}`)}`)
      results.push({ kind: 'open', name: `${k.id} \u2192 ${k.invariant}`, ok: true,
        detail: `TRACKED OPEN since ${k.since ?? '?'} \u2014 ${k.describes ?? ''}` })
    } else {
      record('open', `${k.id} \u2192 ${k.invariant} NO LONGER VIOLATES`, false,
        'either the code was fixed (verify it, then delete this entry) or the invariant was loosened until it passed')
      ok = false
    }
  }
  return ok
}

function firstError(out) {
  if (/\[TIMEOUT\]/.test(out || '')) return 'TIMED OUT — raise the timeout or lower --max-steps; this is NOT a counterexample'
  const line = (out || '').split('\n').find(l => /error|Error|violation|\[QNT/.test(l))
  return (line || '(no detail)').trim().slice(0, 160)
}

// ── commands ──────────────────────────────────────────────────────────────────
function cmdGround(argv) {
  const name = argv.find(x => !x.startsWith('-'))
  if (!name) die('usage: formal ground <model.qnt>')
  const ms = manifests().filter(m => m.model === name || m.model === name + '.qnt')
  if (!ms.length) die(`no manifest for "${name}"`)
  const repoRoot = path.dirname(ROOT)
  for (const m of ms) {
    if (!m.grounds?.sources?.length) die(`${m.__file} has no grounds.sources to stamp`)
    for (const s of m.grounds.sources) {
      const p = path.join(repoRoot, s.path)
      if (!fs.existsSync(p)) die(`grounds source missing: ${s.path}`)
      s.sha256 = sha256(p)
    }
    m.grounds.verified = new Date().toISOString().slice(0, 10)
    const { __file, __path, ...clean } = m
    fs.writeFileSync(path.join(MODELS, __file), JSON.stringify(clean, null, 2) + '\n')
    console.log(`${PASS} re-grounded ${m.model} @ ${m.grounds.verified}`)
    console.log(dim('   You have just asserted, as a human, that this model describes that code.'))
    console.log(dim('   The hash proves nothing about agreement — only that you looked.'))
  }
}

// `formal warm` — pull the toolchain down before the gate runs.
//
// Two separate downloads happen on a cold machine and BOTH are network calls to
// GitHub: the Rust evaluator that `quint run` uses, and the Apalache distribution
// that `quint verify` uses. Unauthenticated, so subject to GitHub's anonymous rate
// limit. Doing this in its own step means a rate limit is reported as a fetch
// failure, not as a mysterious gate failure — which is exactly how it first showed
// up: the same commit passed in one repo and failed in another.
async function cmdWarm() {
  const m = manifests()[0]
  let evaluatorOk = false
  for (let i = 1; i <= 3; i++) {
    const r = quintOnce(['run', m.__path, ...mainArgs(m), '--max-samples=1', '--max-steps=1'],
      { timeoutMs: 180_000 })
    // Any outcome other than a failed FETCH means the evaluator is present. The spec
    // itself may legitimately report a violation at 1 sample; that is not our concern.
    if (!FETCH_FAILED.test(r.out || '')) { evaluatorOk = true; break }
    console.log(`${WARN} rust evaluator fetch failed (attempt ${i}/3) — backing off`)
    execSync(`sleep ${i * 20}`)
  }
  record('warm', 'rust evaluator (quint run)', evaluatorOk,
    evaluatorOk ? '' : 'GitHub fetch failed 3x — the gate will fall back to the slower TypeScript backend at reduced samples')

  let apalacheOk = false
  for (let i = 1; i <= 3; i++) {
    const inst = instancesOf(m)[0]
    const r = quintOnce(['verify', m.__path, ...(inst.main ? [`--main=${inst.main}`] : mainArgs(m)),
      `--invariant=${inst.invariants[0]}`, '--max-steps=1',
      `--server-endpoint=localhost:${nextPort()}`,
      ...(APALACHE_PIN ? [`--apalache-version=${APALACHE_PIN}`] : [])], { timeoutMs: 600_000 })
    if (!FETCH_FAILED.test(r.out || '')) { apalacheOk = true; break }
    console.log(`${WARN} apalache fetch failed (attempt ${i}/3) — backing off`)
    execSync(`sleep ${i * 20}`)
  }
  record('warm', `apalache ${APALACHE_PIN || '(unpinned)'}`, apalacheOk,
    apalacheOk ? '' : 'GitHub fetch failed 3x — `formal check` cannot run')

  const v = detectVersions()
  console.log(dim(`   ~/.quint now holds: apalache ${v.apalache}`))
  process.exit(failed ? 1 : 0)
}

function writeReport(versions) {
  const lines = []
  lines.push('# Formal verification report', '')
  lines.push(`Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z by \`formal check\`.`, '')
  lines.push(`**Tools:** quint \`${versions.quint}\` · apalache \`${versions.apalache}\` · JDK \`${versions.jdk}\``, '')
  lines.push('> A clean `verify` run means "no violation reachable within `--max-steps`" — **not** "safe".',
             '> The bound is quoted beside every result below and must be quoted beside any claim made from it.', '')
  const groups = [...new Set(results.map(r => r.kind))]
  for (const g of groups) {
    lines.push(`## ${g}`, '', '| result | check | detail |', '|---|---|---|')
    for (const r of results.filter(x => x.kind === g)) {
      const stripped = (r.detail || '').replace(/\x1b\[[0-9;]*m/g, '')
      lines.push(`| ${r.ok ? '✅' : '🔴'} | ${r.name} | ${stripped} |`)
    }
    lines.push('')
  }
  lines.push('## What a green report does NOT mean', '',
    '- It does not prove the implementation has these properties. Only a counterexample',
    '  replayed as a real test connects the model to the code.',
    '- It says nothing beyond `--max-steps`.',
    '- It covers only the paths the model contains. Read each model\'s GAPS section.', '')
  fs.writeFileSync(path.join(ROOT, 'REPORT.md'), lines.join('\n'))
  console.log(dim(`\n   report → ${rel(path.join(ROOT, 'REPORT.md'))}`))
}

function main() {
  const [, , cmd = 'check', ...argv] = process.argv
  if (cmd === 'ground') return cmdGround(argv)

  const lock = readVersionsOrLock()
  const versions = checkVersions(lock)
  if (cmd === 'warm') return cmdWarm()
  const ms = only(argv)(manifests())
  if (!ms.length) die('no models matched')

  const quick = cmd === 'quick'
  for (const m of ms) {
    console.log(bold(`\n── ${m.model}`) + (m.grounds?.describes ? dim(`  (${m.grounds.describes})`) : ''))
    if (!quick) checkDrift(m)
    if (!typecheck(m)) continue          // nothing downstream is meaningful
    if (cmd === 'verify') { verify(m); continue }
  if (cmd === 'mutate') { mutate(m); knownOpen(m); continue }
    simulate(m)
    if (quick) continue
    knownOpen(m)
    // Mutations FIRST: if the model cannot detect its own bug classes, a clean
    // verify is worthless and there is no point spending minutes of Apalache on it.
    const proven = mutate(m)
    if (!proven) {
      record('verify', `${m.model} SKIPPED`, false, 'mutation proof failed — a clean verify would be worthless')
      continue
    }
    verify(m)
  }

  if (!quick && cmd === 'check') writeReport(versions)
  console.log(dim(`\n   tier: ${TIER}${TIER === 'fast' ? '  (set FORMAL_TIER=slow or all for the long-running checks)' : ''}`))
  console.log(failed ? red('FAILED') : green('OK'))
  process.exit(failed ? 1 : 0)
}

function readVersionsOrLock() {
  try { return readLock() } catch { return { tools: {} } }
}

main()
