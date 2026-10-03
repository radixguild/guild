import { beforeEach, describe, expect, test } from 'bun:test';
import { REDACTED, _resetSecretsForTests, registerSecret, safeLogger, sanitizeForTerminal, scrub, untrusted, wouldLeak } from './secrets.js';
import { generateThrowawayPrivateKeyHex } from './throwaway-key.js';

beforeEach(() => _resetSecretsForTests());

describe('scrub', () => {
  test('replaces a registered secret wherever it appears, upper-case too', () => {
    const hex = generateThrowawayPrivateKeyHex();
    registerSecret(hex);
    const line = `detail: GUILD_AGENT_PRIVATE_KEY=${hex} and again ${hex.toUpperCase()}`;
    expect(wouldLeak(line)).toBe(true);
    const out = scrub(line);
    expect(out).not.toContain(hex);
    expect(out).not.toContain(hex.toUpperCase());
    expect(out.split(REDACTED).length - 1).toBe(2);
  });

  test('leaves text alone when nothing is registered or nothing matches', () => {
    expect(scrub('hello')).toBe('hello');
    registerSecret(generateThrowawayPrivateKeyHex());
    expect(scrub('hello')).toBe('hello');
    expect(wouldLeak('hello')).toBe(false);
  });

  test('ignores empty / short values so a blank env var cannot blank every line', () => {
    registerSecret('');
    registerSecret(undefined);
    registerSecret('abc');
    expect(scrub('abc abc')).toBe('abc abc');
  });

  test('sanitizeForTerminal strips CSI, OSC and lone escapes and C0/C1 controls, keeps newline and tab', () => {
    const dirty = 'a\u001b[31mred\u001b[0m b\u001b]0;title\u0007 c\u001bM d\u0000e\u0007f\u007fg\u009bh\r\n\ti';
    const clean = sanitizeForTerminal(dirty);
    expect(clean).toBe('ared b c defgh\n\ti');
    expect(clean).not.toContain('\u001b');
  });

  test('🔴 bidi overrides, isolates, zero-width characters and the BOM are stripped — an address cannot be visually reordered by text around it', () => {
    const addr = 'account_rdx12y5senkxfxg38swfv4tg88lx73jqnkdvcnzv8kwwdmg0efl40r2p7u';
    const dirty = `\u202e${addr}\u202c \u2066x\u2069 zero\u200bwidth\u200d \ufeffbom \u061c\u180e`;
    const clean = sanitizeForTerminal(dirty);
    expect(clean).toBe(`${addr} x zerowidth bom `);
    for (const ch of ['\u202e', '\u202c', '\u2066', '\u2069', '\u200b', '\u200d', '\ufeff', '\u061c', '\u180e']) {
      expect(clean).not.toContain(ch);
      expect(untrusted(`a${ch}b`)).toBe('ab');
    }
  });

  test('🔴 line/paragraph separators, soft hyphen, CGJ, variation selectors (both planes) and annotation marks are stripped too', () => {
    for (const ch of ['\u2028', '\u2029', '\u00ad', '\u034f', '\ufe0f', '\u{e0100}', '\u{e01ef}', '\ufff9', '\ufffa', '\ufffb']) {
      expect(sanitizeForTerminal(`a${ch}b`)).toBe('ab');
      expect(untrusted(`a${ch}b`)).toBe('ab');
    }
    // a U+2028 must not be able to start a new terminal line in an error message
    expect(untrusted("x\u2028Your agent's address: spoof")).toBe("xYour agent's address: spoof");
  });

  test('untrusted: one line, no controls, bounded', () => {
    expect(untrusted("x\n\nYour agent's address: spoof\u001b[31m!")).toBe("x ⏎ Your agent's address: spoof!");
    expect(untrusted('a'.repeat(300), 20)).toBe(`${'a'.repeat(20)}…`);
    expect(untrusted(42)).toBe('42');
  });

  test('safeLogger sanitises as well as scrubs', () => {
    const seen: string[] = [];
    safeLogger(l => seen.push(l))('ok \u001b[1mbold\u001b[0m');
    expect(seen).toEqual(['ok bold']);
  });

  test('safeLogger scrubs every line it forwards', () => {
    const hex = generateThrowawayPrivateKeyHex();
    registerSecret(hex);
    const seen: string[] = [];
    const log = safeLogger(l => seen.push(l));
    log(`leak ${hex}`);
    log('clean');
    expect(seen).toEqual([`leak ${REDACTED}`, 'clean']);
  });
});
