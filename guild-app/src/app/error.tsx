"use client"

import { useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("Unhandled error:", error) }, [error])
  return (
    <div className="flex min-h-screen flex-col items-center justify-center text-center px-4">
      <h1 className="text-4xl font-bold text-foreground">Something went wrong</h1>
      <p className="mt-4 text-sm text-muted-foreground max-w-sm">An unexpected error occurred. Try again, or go back to the home page.</p>
      <div className="mt-6 flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Link href="/"><Button variant="outline">Go Home</Button></Link>
      </div>
    </div>
  )
}
