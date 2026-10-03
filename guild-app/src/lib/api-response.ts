import { NextRequest, NextResponse } from "next/server"
import { AppError } from "./errors"
import { logger } from "./hardening/logger"

export function success<T>(data: T, status = 200) {
  return NextResponse.json({ ok: true, data }, { status })
}

export function error(message: string, code: string, status = 400) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status })
}

export function paginated<T>(data: T[], cursor: string | null, hasMore: boolean) {
  return NextResponse.json({ ok: true, data, cursor, hasMore })
}

export function fromError(err: unknown) {
  if (err instanceof AppError) {
    return error(err.message, err.code, err.statusCode)
  }
  console.error("Unhandled error:", err)
  return error("Internal server error", "INTERNAL_ERROR", 500)
}

// --- Enhanced API with request ID tracking (consolidated from hardening framework) ---

const STATUS_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
}

export function getRequestId(req?: NextRequest): string {
  return req?.headers.get("x-request-id") || crypto.randomUUID()
}

export function apiSuccess<T>(
  data: T,
  options?: { status?: number; requestId?: string },
): NextResponse {
  const status = options?.status ?? 200
  const res = NextResponse.json({ ok: true, data }, { status })
  if (options?.requestId) {
    res.headers.set("x-request-id", options.requestId)
  }
  return res
}

export function apiError(
  message: string,
  status: number,
  options?: { code?: string; requestId?: string },
): NextResponse {
  const code = options?.code ?? STATUS_CODES[status] ?? "INTERNAL_ERROR"
  const res = NextResponse.json(
    { ok: false, error: { code, message } },
    { status },
  )
  if (options?.requestId) {
    res.headers.set("x-request-id", options.requestId)
  }
  return res
}

export function apiFromError(err: unknown, requestId?: string): NextResponse {
  if (err instanceof AppError) {
    return apiError(err.message, err.statusCode, { code: err.code, requestId })
  }
  logger.error("Unhandled error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  return apiError("Internal server error", 500, { requestId })
}
