import Link from "next/link"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center text-center px-4">
      <h1 className="text-6xl font-bold text-muted-foreground/60">404</h1>
      <h2 className="mt-4 text-xl font-semibold">Page not found</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-sm">
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/" className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Go Home</Link>
        <Link href="/tasks" className="inline-flex items-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted">Browse Tasks</Link>
      </div>
    </div>
  )
}
