// Minimal hex <-> bytes helpers (no deps; Buffer-free so they run in Node,
// Bun, and a browser <script> tag alike). Mirrors packages/agent-client's
// bytes.ts convention.

export function isHex(value: string, byteLength?: number): boolean {
  if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) return false;
  return byteLength === undefined ? value.length > 0 : value.length === byteLength * 2;
}

export function assertHex(value: string, byteLength: number, name: string): string {
  if (!isHex(value, byteLength)) {
    throw new Error(`Invalid ${name}: expected ${byteLength}-byte hex (${byteLength * 2} chars)`);
  }
  return value.toLowerCase();
}

export function hexToBytes(hex: string): Uint8Array {
  if (!isHex(hex)) throw new Error('Invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
