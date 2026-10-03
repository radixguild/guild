import { NextRequest } from "next/server"
import { logger } from "@/lib/hardening"

export const dynamic = "force-dynamic"

const startedAt = Date.now()

export async function GET() {
  const uptime = Math.floor((Date.now() - startedAt) / 1000)
  logger.debug("Health check", { route: "/api/health", uptime })

  return Response.json({
    ok: true,
    data: {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "0.1.0",
      uptime,
    },
  })
}
