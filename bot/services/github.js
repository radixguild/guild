/**
 * github.js — GitHub PR status checker
 *
 * Checks if a pull request is merged. Used by the verification system
 * to auto-release escrow when a linked PR is merged.
 *
 * No auth needed for public repos. Set GITHUB_TOKEN for private repos
 * or higher rate limits (60/hr → 5000/hr).
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

/**
 * Parse a GitHub PR URL into components.
 * Accepts: https://github.com/owner/repo/pull/123
 * Returns: { owner, repo, number } or null
 */
function parsePRUrl(url) {
  if (!url) return null;
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3]) };
}

/**
 * Check the status of a GitHub pull request.
 * Returns: { merged, state, title, merged_at, html_url } or null on error
 */
async function checkPRStatus(owner, repo, number) {
  try {
    const headers = { "Accept": "application/vnd.github.v3+json", "User-Agent": "radix-guild-bot" };
    if (GITHUB_TOKEN) headers["Authorization"] = "token " + GITHUB_TOKEN;

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
      { headers }
    );

    if (!resp.ok) {
      console.error("[GitHub] PR check failed:", resp.status, owner + "/" + repo + "#" + number);
      return null;
    }

    const pr = await resp.json();
    return {
      merged: pr.merged || false,
      state: pr.state, // open, closed
      title: pr.title,
      merged_at: pr.merged_at,
      html_url: pr.html_url,
      merge_commit_sha: pr.merge_commit_sha,
      base_branch: pr.base?.ref,
    };
  } catch (e) {
    console.error("[GitHub] PR check error:", e.message);
    return null;
  }
}

/**
 * Check rate limit status.
 */
async function checkRateLimit() {
  try {
    const headers = { "User-Agent": "radix-guild-bot" };
    if (GITHUB_TOKEN) headers["Authorization"] = "token " + GITHUB_TOKEN;
    const resp = await fetch("https://api.github.com/rate_limit", { headers });
    const data = await resp.json();
    return {
      remaining: data.rate?.remaining || 0,
      limit: data.rate?.limit || 60,
      reset: data.rate?.reset || 0,
    };
  } catch (e) {
    return { remaining: 0, limit: 60, reset: 0 };
  }
}

module.exports = { parsePRUrl, checkPRStatus, checkRateLimit };
