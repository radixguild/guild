import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the polling-pattern documentation this package promises an agent that
 * cannot rely on a push signal (Guild board task 77 / catalogue P1-21 —
 * docs/GUILD-SEED-TASKS.md: "No webhook exists anywhere in the system
 * (grep-confirmed)"). An agent has to choose between GET /api/v1/tasks and
 * GET /api/v1/agent/feed with no server-side "something changed" signal from
 * either — README.md's "Polling" section is the documented answer.
 *
 * Same rot `readme-documents-cli.test.ts` guards against for the CLI's
 * command list: without a pin, this section could be renamed, gutted, or
 * quietly dropped in a later edit and nothing would notice. The two
 * endpoints it exists to compare are the load-bearing fact — a reader needs
 * to see BOTH named, not just prose that gestures at "polling".
 */
const README = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf8');

const SECTION_HEADING =
  '## Polling: what to watch, how often, and what each endpoint cannot tell you';
const NEXT_HEADING = '## What works today vs. what waits for the pilot';

function pollingSection(): string {
  const start = README.indexOf(SECTION_HEADING);
  const end = README.indexOf(NEXT_HEADING);
  return start >= 0 && end > start ? README.slice(start, end) : '';
}

describe('README documents the polling pattern', () => {
  test('the "Polling" section exists', () => {
    expect(README).toContain(SECTION_HEADING);
  });

  test('the section was actually found (guards against a heading rename)', () => {
    // Without this, every assertion below on an empty slice would vacuously
    // pass if SECTION_HEADING or NEXT_HEADING ever drifted from the README.
    expect(pollingSection().length).toBeGreaterThan(500);
  });

  test('both endpoints an agent must choose between are named', () => {
    const section = pollingSection();
    expect(section).toContain('/api/v1/tasks');
    expect(section).toContain('/api/v1/agent/feed');
  });

  test('the section is honest that no webhook exists yet', () => {
    expect(pollingSection()).toContain('No webhook exists');
  });

  test('the section gives a concrete cadence, not just a shrug', () => {
    // The task text explicitly wants a stated recommendation ("not a
    // guarantee"), not a vague "poll periodically" — pin the actual numbers
    // this doc derives from the on-chain agent_submit_deadline_secs /
    // review_window_secs constants (docs/ESCROW-ADDRESSES.md).
    const section = pollingSection();
    expect(section).toContain('60–120s');
    expect(section).toContain('5–10 min');
  });
});
