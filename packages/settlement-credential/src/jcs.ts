// RFC 8785 JSON Canonicalization Scheme (JCS) — enough of it to sign over.
//
// Object keys are sorted by UTF-16 code unit (exactly what JS's default
// `Array.prototype.sort()` does on strings), strings use standard JSON
// escaping (which already matches JCS: no unnecessary escapes, no over-
// escaping of non-ASCII), and numbers are rendered with the ECMAScript
// Number::toString algorithm — which RFC 8785 §3.2.2.3 *specifies by
// reference* as the required number serialization, and which is exactly
// what `String(n)` already does inside a JS engine. So the only code this
// file needs to write is key sorting + recursive structure; there is no
// hand-rolled float-formatting logic to get subtly wrong.
//
// Caveat, stated rather than hidden: this has been exercised against the
// value shapes this package's credentials actually use — plain objects,
// arrays, strings, safe integers, booleans, null (see jcs.test.ts, incl.
// the RFC 8785 Appendix B "structural" vector for key ordering). It has NOT
// been stress-tested against exotic float edge cases (subnormals, values
// right at the `1e21` exponential-notation boundary) — none of those occur
// in a settlement credential, so this is a deliberate scope limit, not an
// oversight.

export function canonicalize(value: unknown): string {
  return canon(value);
}

function canon(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`JCS: cannot canonicalize non-finite number (${value})`);
    }
    return String(value);
  }

  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    return '[' + value.map((v) => canon(v)).join(',') + ']';
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(',') + '}';
  }

  throw new Error(`JCS: cannot canonicalize value of type ${typeof value}`);
}

/** Canonicalize then UTF-8 encode — the bytes a proof is actually signed over. */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
