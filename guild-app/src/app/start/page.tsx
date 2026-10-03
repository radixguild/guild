import { redirect } from "next/navigation"

// /start merged into /guide (MVP-5 chrome trim). This was "the link you send
// someone" — shared externally and sitemap-indexed — so it redirects rather
// than 404s, same as /governance and /proposals before it. The onboarding
// copy (wallet setup, browse-without-connecting, 1-2-3 connect) lives on
// /guide now.
export default function StartRedirect() {
  redirect("/guide")
}
