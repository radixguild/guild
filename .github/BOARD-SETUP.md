# Suggestion & Dev-Board Setup — run once per repo

One-time `gh` setup that turns GitHub Issues + Projects into the tracker for
community suggestions (via the Task/Decision templates in `ISSUE_TEMPLATE/`)
and the maintainer's own task list. Run from the repo root with `gh`
authenticated as the owner. Repeat wherever you reuse this same
`type:`/`status:`/`phase:` label scheme.

## 1. Apply labels (one-time)

`labels.yml` is the source of truth for the label set (name, color,
description). There's no built-in `gh label sync` — either install a
third-party tool or just run the block below. Nothing keeps the two in sync
automatically, so if you add or rename a label, update both.

```bash
npm i -g github-label-sync
# convert labels.yml → the format github-label-sync wants, OR just create manually:
```

Manual (copy-paste, ~30s):

```bash
gh label create "type:task"          --color 1d76db --description "A unit of work" --force
gh label create "type:decision"      --color d93f0b --description "A choice only bigdev can make" --force
gh label create "type:bug"           --color d73a4a --description "Something broken in the app, the CI, or the docs" --force
gh label create "status:pending"     --color ededed --description "Not started" --force
gh label create "status:in-progress" --color fbca04 --description "Claude actively drafting" --force
gh label create "status:draft-ready" --color 0e8a16 --description "Awaiting bigdev desktop review" --force
gh label create "status:shipped"     --color 5319e7 --description "Reviewed + tested + deployed" --force
gh label create "status:blocked"     --color b60205 --description "Waiting on decision/task" --force
gh label create "status:needs-bigdev" --color e99695 --description "Decision required" --force
gh label create "phase:P1" --color c5def5 --force
gh label create "phase:P2" --color bfd4f2 --force
gh label create "phase:P3" --color d4c5f9 --force
gh label create "phase:P4" --color fef2c0 --force
gh label create "phase:backlog" --color ededed --force
gh label create "exec:mac"    --color 0052cc --description "Mac Claude — code+build+deploy" --force
gh label create "exec:vps"    --color 006b75 --description "VPS Claude — draft only" --force
gh label create "exec:bigdev" --color 5319e7 --description "bigdev — decision/sign/deploy" --force
gh label create "sev:critical" --color b60205 --force
gh label create "sev:high"     --color d93f0b --force
gh label create "sev:medium"   --color fbca04 --force
gh label create "sev:low"      --color 0e8a16 --force
```

## 2. Optional: a cross-repo board

None of this is required for the suggestion process itself — Issues + labels
already give you the whole workflow. This step is only for a maintainer who
also wants one dashboard spanning several repos that share this label scheme.

```bash
# GitHub Projects v2 (a user-level board that can span every repo you use this scheme in)
gh project create --owner bigdevxrd --title "bigdev Ops"
# note the project number it returns, e.g. 3
```

Add columns via the web UI (Projects v2 status field): `Pending → In-progress → Draft-ready → Shipped`.
Add a `Blocked` and `Needs-bigdev` swimlane too.

## 3. Seed from an existing task list (bulk import)

If you're migrating from a plain markdown list with rows like
`G-101 · setMyCommands · ...`, bulk-create issues:

```bash
# one issue per task line — adjust the parse to your list's format
gh issue create --title "[TASK] G-101 <short description>" \
  --body "Phase P1. File <area>/<file>. Effort 1hr." \
  --label "type:task,phase:P1,status:pending"
```

## 4. How suggestions flow

- **Anyone** opens a Task or Decision issue from the templates in `ISSUE_TEMPLATE/`.
- **Triage**: `status:`/`phase:`/`sev:` labels sort it; a `status:needs-bigdev`
  decision blocks whatever references it (via the "needs"/"unblocks" fields)
  until it's answered.
- **Work happens** against the issue; `exec:*` marks who's expected to pick it
  up. The person or agent drafting moves it to `status:draft-ready` when ready
  for review — never straight to `status:shipped`.
- **Review + ship**: CODEOWNERS routes every PR through the maintainer;
  merging (or a separate pass) moves the issue to `status:shipped`.
- Answering `status:needs-bigdev` issues first unblocks everything else —
  that's the one label worth triaging on a phone.

## 5. Why GitHub Issues, not a doc in the repo

A markdown task list lives inside one checkout — easy to lose, overwrite, or
let drift out of sync with whichever branch is current. GitHub Issues and
Projects live on GitHub itself, independent of any single clone: reachable
from any device, and never wiped by a checkout getting reset or replaced.

## 6. Commit-to-issue linking

Every commit or PR that closes a task references it, e.g.
`git commit -m "G-101: setMyCommands bootstrap (closes #42)"`.
GitHub auto-closes the issue and leaves a permanent trail of what shipped when.
