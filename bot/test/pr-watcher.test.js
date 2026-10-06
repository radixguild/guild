'use strict';
// The PR watcher's auto-verify decision (2026-10-06). With approval_type 'pr_merged' and
// no approval_repo, index.js checkPRMerges verified a bounty on ANY merged PR, so a worker
// could merge a PR in a repository of their own. Such a bounty is now left for a person
// to verify. And parsePRUrl is anchored to github.com: it used to accept any URL that
// merely contained "github.com/<owner>/<repo>/pull/<n>".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parsePRUrl, prAutoVerifyTarget } = require('../services/github');

const PR = 'https://github.com/radixguild/guild/pull/42';
const bounty = (over) => ({ id: 1, approval_type: 'pr_merged', approval_repo: 'radixguild/guild', github_pr: PR, ...over });

describe('parsePRUrl', () => {
  it('parses a GitHub pull request URL, with or without a trailing path, query or fragment', () => {
    for (const u of [PR, PR + '/', PR + '/files', PR + '?w=1', PR + '#discussion', 'http://github.com/radixguild/guild/pull/42', 'https://www.github.com/radixguild/guild/pull/42']) {
      assert.deepEqual(parsePRUrl(u), { owner: 'radixguild', repo: 'guild', number: 42 }, u);
    }
  });

  it('REGRESSION: refuses a URL on another host that only contains github.com/…/pull/N', () => {
    for (const u of [
      'https://evil.example/github.com/radixguild/guild/pull/42',
      'https://github.com.evil.example/radixguild/guild/pull/42',
      'https://notgithub.com/radixguild/guild/pull/42',
      'https://github.com/radixguild/guild/issues/42',
      'javascript:alert(1)//github.com/a/b/pull/1',
      '',
      null,
      42,
    ]) {
      assert.equal(parsePRUrl(u), null, String(u));
    }
  });
});

describe('prAutoVerifyTarget', () => {
  it('auto-verifies only against the named approval repo', () => {
    assert.deepEqual(prAutoVerifyTarget(bounty()), { ok: true, parsed: { owner: 'radixguild', repo: 'guild', number: 42 } });
  });

  it('REGRESSION: a bounty with no approval_repo is not auto-verified', () => {
    for (const approval_repo of [null, undefined, '']) {
      assert.deepEqual(prAutoVerifyTarget(bounty({ approval_repo })), { ok: false, reason: 'no_approval_repo' });
    }
  });

  it('a PR in another repository is not auto-verified', () => {
    const r = prAutoVerifyTarget(bounty({ github_pr: 'https://github.com/someone/own-repo/pull/1' }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'repo_mismatch');
  });

  it('a bounty that is not pr_merged, or whose PR URL does not parse, is not auto-verified', () => {
    assert.equal(prAutoVerifyTarget(bounty({ approval_type: 'admin_approved' })).reason, 'not_pr_merged');
    assert.equal(prAutoVerifyTarget(bounty({ github_pr: 'https://evil.example/github.com/radixguild/guild/pull/42' })).reason, 'bad_pr_url');
    assert.equal(prAutoVerifyTarget(null).ok, false);
  });
});

describe('index.js checkPRMerges', () => {
  it('asks prAutoVerifyTarget before checking a PR, and skips every refusal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = src.indexOf('async function checkPRMerges()');
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const decide = body.indexOf('prAutoVerifyTarget(bounty)');
    const check = body.indexOf('checkPRStatus(');
    assert.ok(decide >= 0 && check > decide, 'the decision must come before the GitHub call');
    assert.match(body.slice(decide, check), /if \(!target\.ok\) \{[\s\S]*continue;\s*\}/);
    assert.match(body.slice(check), /checkPRStatus\(parsed\.owner, parsed\.repo, parsed\.number\)/);
    assert.doesNotMatch(body, /parsePR\(/);
  });
});
