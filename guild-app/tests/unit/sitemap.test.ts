import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";

/**
 * The sitemap must list /auditor-guide and /bug-bounty — both are public,
 * indexable pages, and /bug-bounty is the security-reporting surface we want
 * crawlers to find.
 *
 * Host-AGNOSTIC by design (#214 trap): each <loc> URL is prefixed with
 * NEXT_PUBLIC_SITE_URL, which is localhost locally but radixguild.com on CI.
 * Asserting the PATH (via URL().pathname) instead of the full URL keeps this
 * green in both places.
 */
describe("sitemap route coverage", () => {
  const paths = sitemap().map((entry) => new URL(entry.url).pathname);

  it.each(["/auditor-guide", "/bug-bounty"])("lists %s", (path) => {
    expect(paths).toContain(path);
  });
});
