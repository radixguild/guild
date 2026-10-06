import { sql } from "drizzle-orm"
import { db } from "@/db"
import { logger } from "@/lib/hardening"

export const dynamic = "force-dynamic"

const startedAt = Date.now()

// How long the database probe may take before health reports it down.
const DB_PROBE_TIMEOUT_MS = 2_000

/**
 * Liveness AND readiness: answers 200 only when the process is up and the
 * database answers a trivial query. Anything else (unreachable, slow past the
 * timeout, DATABASE_URL unset) is 503 `status: "degraded"`. A post-deploy
 * check or an uptime monitor pointed here must not read "the process started"
 * as "the site works" — every task, auth and escrow route needs the database.
 * The body says only which check failed, never why (no connection strings or
 * driver errors).
 */
async function probeDb(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("db probe timed out")), DB_PROBE_TIMEOUT_MS)
    })
    await Promise.race([db.execute(sql`select 1`), timeout])
    return true
  } catch (err) {
    logger.warn("Health check: database probe failed", {
      route: "/api/health",
      error: err instanceof Error ? err.name : "unknown",
    })
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function GET() {
  const uptime = Math.floor((Date.now() - startedAt) / 1000)
  const dbOk = await probeDb()
  logger.debug("Health check", { route: "/api/health", uptime, db: dbOk })

  return Response.json(
    {
      ok: dbOk,
      data: {
        status: dbOk ? "ok" : "degraded",
        checks: { db: dbOk ? "ok" : "unreachable" },
        timestamp: new Date().toISOString(),
        version: "0.1.0",
        uptime,
      },
    },
    { status: dbOk ? 200 : 503 },
  )
}
