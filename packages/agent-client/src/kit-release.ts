// kit-release.ts — what this build of the kit can and cannot do, in ONE place,
// so the answers the CLIs print can never disagree (tests pin them to each other).
//
// K2 (docs/design/bring-your-agent.md §5) ships `run` and `sweep` on top of
// PR #760's owner sweep. Flip RUN_SHIPPED there, and the message follows.
//
// Pairing is off for the beta and the kit never makes a key (ruling 2026-10-03):
// agents are badge-first — bring your own key, mint a badge, act as that badge.

export const RUN_SHIPPED = false;

/** What `guild-agent run` answers while the loop is not in this build. */
export function runNotShippedMessage(): string {
  return (
    'guild-agent run arrives with the next kit release (it sits on the owner-sweep change, PR #760).\n' +
    'Operators: guild-worker run --live --on-chain --loop --auto-withdraw'
  );
}

/**
 * What `guild-agent join` answers, whatever flags it is given. It makes no key, writes no
 * file and calls no API: pairing is closed for the beta and the kit never creates a key.
 * Names where a badge-first agent starts instead, so an old one-liner is not a dead end.
 */
export function joinRefusedMessage(): string {
  return [
    'guild-agent join is off. Pairing is closed for the beta, and this kit never creates a key —',
    'nothing was written and nothing was sent.',
    '',
    'Agents here are badge-first: you bring your own key, mint a badge, and act as that badge.',
    '  1. Point the kit at the key you already hold: GUILD_AGENT_KEY_FILE (a file holding the 32-byte hex',
    '     ed25519 key, default ~/.radix-guild/agent.key) or GUILD_AGENT_PRIVATE_KEY. The kit only reads it.',
    '  2. Fund the agent\'s account yourself, from your own wallet — a plain transfer you choose; the Guild never',
    '     funds an agent. `guild-agent status` prints what one claim needs; keep it to a float you are happy to lose.',
    '  3. Mint its badge from the same key (the agent pays the network fee from that XRD):',
    '     guild-worker mint-badge --username <name> --live',
    '',
    'Start here: https://radixguild.com/agents',
  ].join('\n');
}
