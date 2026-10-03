// secrets.ts — one place that knows what must never be printed.
//
// The agent's private key is loaded in exactly one process (the CLI), but it
// can reach output through paths nobody wrote on purpose: a doctor detail that
// echoes an env var, an error message that quotes its input, a --json dump.
// Every CLI output path — join's progress lines, status's report and JSON, the
// top-level fatal handler — goes through `scrub()`, which replaces any
// registered secret with a marker. Registration happens where the key is
// loaded; nothing else needs to know the value.
//
// Redact, don't throw: a diagnostic that would have carried the key is still a
// diagnostic the person needs. Tests pin that output never contains the hex.

const registered = new Set<string>();

export const REDACTED = '[key redacted]';

/** Remember a secret so scrub() can remove it. Idempotent; ignores empty strings. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) registered.add(value);
}

/** Replace every registered secret (and its upper-case form) in `text`. */
export function scrub(text: string): string {
  let out = text;
  for (const s of registered) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
    const upper = s.toUpperCase();
    if (upper !== s && out.includes(upper)) out = out.split(upper).join(REDACTED);
  }
  return out;
}

/** True when `text` would have leaked a registered secret (before scrubbing). */
export function wouldLeak(text: string): boolean {
  for (const s of registered) {
    if (text.includes(s) || text.includes(s.toUpperCase())) return true;
  }
  return false;
}

// ESC-introduced sequences (CSI, OSC, single-char), then every C0/C1 control
// except newline and tab. A server-supplied string must never be able to move
// the cursor, recolour text or fake a line on the person's terminal.
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
// Unicode formatting characters that reorder, hide or break text on a
// terminal: bidi embeddings/overrides/isolates, zero-width joiners/spaces,
// the line/paragraph separators, the soft hyphen, the combining grapheme
// joiner, variation selectors (both planes), interlinear annotation marks,
// the BOM, the Arabic letter mark and the Mongolian vowel separator. An
// address a person is asked to compare by eye must not be reorderable, and a
// server string must not be able to start a new terminal line.
const INVISIBLE_RE = new RegExp(
  '[\\u00ad\\u034f\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u2069' +
    '\\ufe00-\\ufe0f\\ufeff\\ufff9-\\ufffb\\u{e0100}-\\u{e01ef}]',
  'gu'
); // built from a string so the source stays ASCII (U+2028 inside a regex literal is a line terminator)

/** Strip terminal control sequences, control characters and invisible/bidi formatting (keeps \n and \t). */
export function sanitizeForTerminal(text: string): string {
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
}

/**
 * For a value that came from outside (a server error message, a field the
 * wire check could not fully pin): one line, no controls, bounded length.
 */
export function untrusted(text: unknown, max = 200): string {
  const s = sanitizeForTerminal(String(text)).replace(/[\r\n]+/g, ' ⏎ ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Wrap a line logger so nothing it prints can carry a registered secret or a control sequence. */
export function safeLogger(log: (line: string) => void): (line: string) => void {
  return line => log(sanitizeForTerminal(scrub(line)));
}

/** Test seam: forget everything registered. */
export function _resetSecretsForTests(): void {
  registered.clear();
}
