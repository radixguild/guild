// base58btc — the multibase encoding did:key uses (multibase prefix 'z').
// Plain BigInt big-endian base-256 -> base-58 conversion; no dependency.
// Bitcoin/IPFS alphabet (excludes 0 O I l to avoid visual ambiguity).

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);

  let digits = '';
  while (value > 0n) {
    const remainder = value % 58n;
    digits = ALPHABET[Number(remainder)] + digits;
    value /= 58n;
  }

  // Each leading 0x00 byte becomes a leading '1' (base58's zero-byte convention).
  let leadingZeros = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    leadingZeros++;
  }
  return '1'.repeat(leadingZeros) + digits;
}

export function base58btcDecode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);

  let value = 0n;
  for (const ch of input) {
    const digit = ALPHABET_MAP.get(ch);
    if (digit === undefined) {
      throw new Error(`invalid base58btc character: ${JSON.stringify(ch)}`);
    }
    value = value * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }

  let leadingOnes = 0;
  for (const ch of input) {
    if (ch !== '1') break;
    leadingOnes++;
  }
  return new Uint8Array([...new Array(leadingOnes).fill(0), ...bytes]);
}
