import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/hardening/logger";

export function proxy(req: NextRequest): NextResponse {
  const requestId = crypto.randomUUID();
  const { method, nextUrl } = req;
  const path = nextUrl.pathname;

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "0");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  response.headers.set("X-Request-Id", requestId);

  logger.info("request", { requestId, method, path });

  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
