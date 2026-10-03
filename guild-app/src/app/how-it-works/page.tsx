import { redirect } from "next/navigation"

// /how-it-works merged into /guide (MVP-5 chrome trim). The flow, honesty
// markers, dispute-insurance and why-trust copy moved there verbatim
// (#how-it-works anchor). Redirect preserves old bookmarks, external links
// and the sitemap-indexed URL.
export default function HowItWorksRedirect() {
  redirect("/guide#how-it-works")
}
