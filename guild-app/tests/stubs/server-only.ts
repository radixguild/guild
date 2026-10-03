// Stub for Next.js's "server-only" virtual module so vitest can import
// server-only files (e.g. src/lib/rola.ts). The real module throws at
// build time if imported into a client bundle; the stub is a no-op.
export {};
