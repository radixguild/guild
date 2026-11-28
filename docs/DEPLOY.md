<!-- status: live
     verified: 2026-11-28 (`file:line` references re-checked against `main` at `8e3105a`; first written 2026-11-25 from the files in this tree only. No step was run. Each command
     below exists in this repository at the `file:line` given; each step this repository does not
     contain is marked "operator step, not in this repo".)
     supersedes: none (new page; no earlier doc in this repository covered deploy or rollback) -->
# Deploy and rollback

Draft from the repository contents; not yet run end to end from a clean machine.

How to build, start, check and roll back the three things this repository ships as a running
service: the dashboard (`guild-app/`), the kit tarballs it serves (`packages/agent-client/` and
`packages/agent-mcp/`), and the Telegram bot (`bot/`). The deploy tooling for a hosted instance
lives outside this repository, so some steps are named here by what they must achieve and not by a
command. Those steps read "operator step, not in this repo".

Placeholders: `<host>` the machine, `<app-dir>` the checkout of `guild-app/`, `<kit-dir>` the
directory the web server serves as `/kit/`, `<domain>` the public domain, `<pm2-app>` the name the
process manager gives the dashboard. Every name the services read is in [`ENVIRONMENT.md`](./ENVIRONMENT.md).

## What this repository gives you

| Piece | In this repo | Where |
|---|---|---|
| Build and start scripts | yes | `guild-app/package.json` (`build`, `postbuild`, `start`, `db:migrate`) |
| Database migrations | yes, forward only | `guild-app/drizzle/` (`0000` to `0031`) |
| Kit packing, version guard, carry-forward | yes, except the leak gate | `scripts/pack-kit.sh`, `scripts/kit-version-guard.mjs`, `scripts/kit-carry-forward.sh` |
| Build and kit swap with undo, and process restart | yes | `scripts/deploy-swap.sh` |
| Health route | yes | `guild-app/src/app/api/health/route.ts` |
| Process manager definition | no | operator step, not in this repo: define the dashboard and the bot as managed processes with the working directory, command and environment of the sections below |
| Reverse proxy and TLS | no | operator step, not in this repo: terminate TLS for `<domain>`, proxy to the dashboard on loopback, and serve `/kit/*` straight from `<kit-dir>` |
| Pre-restart launch gate | no | operator step, not in this repo: a check run against the built candidate before it is swapped in (`docs/AUDITOR-GUIDE.md:245-247` and `docs/HOW-IT-WORKS.md:87` say this gate is kept outside the repository) |

## Prerequisites

- Node 22 (`CONTRIBUTING.md:101-105`) and PostgreSQL 16 (`README.md:86-87`; CI uses the same major,
  `.github/workflows/test.yml:368-369`).
- A process manager. `scripts/deploy-swap.sh:48,209` calls `pm2 restart <pm2-app> --update-env`, and
  `PM2_BIN` overrides the command.
- The dashboard's start script binds `127.0.0.1` (`guild-app/package.json`, `start`), so a reverse
  proxy is needed for any outside access (operator step, not in this repo).
- The environment of [`ENVIRONMENT.md`](./ENVIRONMENT.md). `DATABASE_URL` and `JWT_SECRET` are required
  (`guild-app/src/db/index.ts:6-8`, `guild-app/src/lib/auth.ts:22-25`).
  `NEXT_PUBLIC_*` names are fixed when the build runs, so set them before step 6.
- Never set `GUILD_E2E_BUILD` or `GUILD_E2E_AUTH_BYPASS` for a real build
  (`guild-app/next.config.ts:127-144`, `guild-app/src/lib/rola.ts:167`).

## Dashboard: build order

Run from `<app-dir>` (the `guild-app/` directory) unless stated; the `scripts/` paths are from the repository root. `guild-app/` also keeps a `bun.lock`; production installs from
`package-lock.json` with `npm ci` (`CONTRIBUTING.md:105-107`).

1. **Fix the revision.** Operator step, not in this repo: check out the exact commit to deploy and
   record `git rev-parse HEAD`, so a rollback can name what it goes back to.
2. **Back up the database.** Operator step, not in this repo: a restorable copy of the
   `DATABASE_URL` database taken before step 4. The migrations are forward only (see Rollback).
3. **Install.** `npm ci` in `<app-dir>`.
4. **Apply migrations.** `npm run db:migrate` (`guild-app/package.json`; it runs `drizzle-kit migrate`
   against `DATABASE_URL`, `guild-app/drizzle.config.ts:8`). Run it again after any pull that adds a
   file under `guild-app/drizzle/` (`README.md:95`).
5. **Pack the kits.** Optional unless the page should print the kit hash and `/kit/*` should serve a
   tarball; `scripts/deploy-swap.sh:53-56` stops when the kit candidate directory does not exist.
   Into a fresh `<kit-candidate>` directory:
   - `scripts/pack-kit.sh --pkg packages/agent-client --name agent --out <kit-candidate>`
   - `scripts/pack-kit.sh --pkg packages/agent-mcp --name mcp --out <kit-candidate>`

   `pack-kit.sh` runs `node scripts/publish-gate.mjs` before it packs (`scripts/pack-kit.sh:80`) and
   `scripts/publish-gate.mjs` is not in this repository, so as shipped here the script stops at that
   line. Operator step, not in this repo: the leak scan of the package files that `pack-kit.sh`
   expects, exiting non-zero when a file must not ship.

   Then, against the kit directory that is live now (skip both on a first deploy with no live kit):
   - `node scripts/kit-version-guard.mjs --candidate <kit-candidate> --live <kit-dir> --kit agent --kit mcp`
     (`scripts/kit-version-guard.mjs:112`) stops a changed tarball from going out under an unchanged
     version.
   - `scripts/kit-carry-forward.sh <kit-dir> <kit-candidate> agent mcp`
     (`scripts/kit-carry-forward.sh:46`) copies the earlier versioned tarballs into the candidate so
     pinned URLs keep working.
6. **Build into a candidate directory.** `NEXT_DIST_DIR=.next-candidate npm run build`
   (`guild-app/next.config.ts:165`). With `NEXT_DIST_DIR` set to anything other than `.next`, the
   build uses `guild-app/tsconfig.candidate.json` (`guild-app/next.config.ts:177`), so the live
   build keeps serving while the candidate builds. `npm run build` also runs the `postbuild`
   script, `node scripts/build-support-corpus.mjs`, which reads `.next/server/app`, not the
   candidate directory (`guild-app/scripts/build-support-corpus.mjs:498`). Unverified: what that
   means for a candidate build.
   A candidate build edits `guild-app/tsconfig.candidate.json` and `tsconfig.json`
   (`guild-app/next.config.ts:166-175`); restore both from git after the build (operator step, not in
   this repo).
   `NEXT_PUBLIC_KIT_SHA256` and `NEXT_PUBLIC_KIT_VERSION` are read at build time
   (`guild-app/src/lib/kit.ts:18,22`). Operator step, not in this repo: fill them from the
   `agent.tgz.sha256` and `agent.json` that step 5 wrote (`scripts/pack-kit.sh:6-12`).
7. **Run the checks this repo has.** `npm run typecheck`, `npm run lint` and `npm run test`
   (`guild-app/package.json`). Then the launch gate: operator step, not in this repo.
8. **Swap and restart.** From the repository root, with `<app-dir>` the path of its `guild-app/`
   directory.

   Read this before the command. Pass absolute paths for the three kit directories: the script
   changes into `<app-dir>` first (`scripts/deploy-swap.sh:50`), so a relative path is read from
   there. The script deletes whatever is at its sixth argument (`<kit-previous>`) before it moves
   anything (`scripts/deploy-swap.sh:193`), and whatever is at its third (`.next-previous`) just before
   it moves the build (`scripts/deploy-swap.sh:200`), so each deploy discards the build and kit the
   deploy before it kept: only one step of rollback is on disk. The script's
   header refers to a wrapper that is not in this repository; read the whole script before running it
   by hand.

   ```
   bash scripts/deploy-swap.sh <app-dir> .next-candidate .next-previous <kit-candidate> <kit-dir> <kit-previous> <pm2-app>
   ```

   The seven arguments are named at `scripts/deploy-swap.sh:44,47`. The script moves the live kit to
   `<kit-previous>` and the candidate kit into `<kit-dir>`, moves `.next` to `.next-previous` and the
   candidate build into `.next`, then runs `pm2 restart <pm2-app> --update-env`
   (`scripts/deploy-swap.sh:192-209`). If a step fails, it undoes the moves in reverse and exits
   non-zero (`scripts/deploy-swap.sh:190`, the `undo` function, and its header at lines 12-22).
   On a box with no previous build there is nothing to go back to: the candidates stay in place and the
   restart is retried (`scripts/deploy-swap.sh:25-29`).
   The process definition that `<pm2-app>` names is an operator step, not in this repo.

## Dashboard: verify

- `curl -fsS https://<domain>/api/health` answers 200 with `"status":"ok"` when the process is up and
  the database answers a trivial query, and 503 with `"status":"degraded"` otherwise
  (`guild-app/src/app/api/health/route.ts:15-57`).
- Load `https://<domain>/` and `https://<domain>/trust` in a browser (`guild-app/src/app/trust/page.tsx`).
- Kit, when step 5 ran: fetch `https://<domain>/kit/agent.tgz` and `https://<domain>/kit/agent.tgz.sha256`
  and run the check the second file is written for, `sha256sum -c` (or `shasum -a 256 -c`) on the pair
  (`scripts/pack-kit.sh:6-9`).
- `guild-app/scripts/kit-hash-watch.mjs` compares the served kit bytes with the recorded hashes and
  has a `--dry-run` that sends nothing (`guild-app/scripts/kit-hash-watch.mjs:3-5`).

## Bot (`bot/`)

1. **Install.** `npm ci` in `bot/`, on Node 22 (`CONTRIBUTING.md:101-102`).
2. **Environment.** `TG_BOT_TOKEN` is required (`bot/index.js:22-23`). The bot loads a `.env` file from
   its working directory (`bot/index.js:1`). The rest is in [`ENVIRONMENT.md`](./ENVIRONMENT.md#bot).
3. **Database.** SQLite, created on first start at `BOT_DB_PATH`, or `guild.db` beside `bot/db.js`
   (`bot/db.js:5`). `db.js` creates tables and adds columns itself at startup
   (`bot/db.js:15,58`); there is no separate migration command. Copy it only with
   `sqlite3 <db> ".backup <file>"` (`bot/README.md`, section "What it runs").
4. **Start.** `npm start` in `bot/` (`bot/package.json`, `start`). Run it under the process manager
   (operator step, not in this repo).
5. **Verify.** `GET /api/stats` on the bot's own port needs no key and reads only the database
   (`bot/README.md`; the port is `API_PORT`, default 3003, `bot/services/api.js:19`, bound to
   `API_HOST`, default `127.0.0.1`, `bot/services/api.js:1619`). Which of the bot's routes the proxy
   exposes is an operator step, not in this repo.

## Rollback

**During a deploy.** `scripts/deploy-swap.sh` undoes its own moves when a step in it fails and prints
what is on disk afterwards, read back from the directories (`scripts/deploy-swap.sh:87-188`). Before
that script runs, nothing live has moved: a failed install, migration, pack or build leaves the old
build and kit in place, except that a migration already applied stays applied.

**After a successful deploy, to the previous build.** The script keeps the previous build and kit as
`.next-previous` and `<kit-previous>` (`scripts/deploy-swap.sh:212`). The script has no rollback mode.
Running it again with the roles swapped gives the same two moves and restart in the other direction;
this is read from how the script treats its arguments, not run, and the script's header
(`scripts/deploy-swap.sh:1-40`) describes only the deploy direction:

As in step 8, pass absolute paths for the three kit directories (`scripts/deploy-swap.sh:50`).

```
bash scripts/deploy-swap.sh <app-dir> .next-previous .next-rolled-back <kit-previous> <kit-dir> <kit-rolled-back> <pm2-app>
```

- `.next-rolled-back` and `<kit-rolled-back>` must be names that hold nothing you need. The script runs
  `rm -rf` on its sixth argument before the kit move and on its third before the build move
  (`scripts/deploy-swap.sh:193,200`).
- It stops without moving anything if `.next-previous` or `<kit-previous>` does not exist
  (`scripts/deploy-swap.sh:52-60`). A first deploy has neither.
- Check the result with the steps in "Dashboard: verify".

**Database.** The files in `guild-app/drizzle/` are forward migrations only; there is no down
migration in this repository. Going back to a build that expects an older schema therefore means one
of two things, and which one holds for a given release is not recorded here: the older build runs on
the newer schema, or the database is restored from the copy taken in step 2 (operator step, not in
this repo: the restore).

**Settings.** `NEXT_PUBLIC_*` names are baked in at build, so reverting one means a rebuild and a
swap. The other names in [`ENVIRONMENT.md`](./ENVIRONMENT.md) are read at runtime and need a process restart
(`pm2 restart <pm2-app> --update-env`, `scripts/deploy-swap.sh:209`), except `GUILD_HALT`, which is read
on every request (`guild-app/src/lib/gateway.ts:1859-1862`).

**Bot.** Check out the earlier revision, `npm ci` in `bot/`, and restart the process (operator step, not
in this repo: the process manager). Because `bot/db.js` changes the SQLite schema when it starts
(`bot/db.js:58-59`), keep the `.backup` copy from before the newer revision first started, in case
the earlier revision does not open the newer file. Whether it does is unverified.

## Not covered here

The on-chain side: the escrow and NFT swap blueprints in `escrow/` are built and published with the
Scrypto toolchain (`README.md:114-116`). Publishing or replacing a package is not a step of this
page, and nothing here says that a package other than the one `docs/AUDITOR-GUIDE.md` and
[`STATE.md`](../STATE.md) name as live is deployed.
