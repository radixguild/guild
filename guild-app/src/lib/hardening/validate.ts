import type { ZodSchema } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { logger } from "./logger";

export function sanitize(input: string, maxLength = 10000): string {
  return input.trim().replace(/\0/g, "").slice(0, maxLength);
}

export async function validateBody<T>(
  schema: ZodSchema<T>,
  req: NextRequest,
): Promise<{ data: T } | { error: NextResponse }> {
  const body = await req.json().catch((err: unknown) => {
    logger.warn("Failed to parse request body as JSON", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (body === null) {
    return {
      error: NextResponse.json(
        { ok: false, error: { code: "INVALID_BODY", message: "Invalid JSON" } },
        { status: 400 },
      ),
    };
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      error: NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message } },
        { status: 400 },
      ),
    };
  }

  return { data: parsed.data };
}

export function validateQuery<T>(
  schema: ZodSchema<T>,
  req: NextRequest,
): { data: T } | { error: NextResponse } {
  const { searchParams } = new URL(req.url);
  const obj = Object.fromEntries(searchParams.entries());

  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    return {
      error: NextResponse.json(
        { ok: false, error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0].message } },
        { status: 400 },
      ),
    };
  }

  return { data: parsed.data };
}
