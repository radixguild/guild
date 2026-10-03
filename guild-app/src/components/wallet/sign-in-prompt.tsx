"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { useWallet } from "@/hooks/useWallet"

interface SignInPromptProps {
  title?: string
  description?: string
  /** Called after a successful sign-in — typically re-fetches the gated data. */
  onSignedIn?: () => void
}

/**
 * Reusable dead-end CTA for content that needs a guild_session. Renders an
 * empty state with a single "Sign in" button that runs the ROLA sign-in (one
 * wallet signature) and, on success, invokes onSignedIn so the caller can
 * reload. Drop this wherever a protected read 401s instead of showing a
 * static "please sign in" message with no way to act on it.
 */
export function SignInPrompt({
  title = "Sign in required",
  description = "Approve a one-time wallet signature to verify your account.",
  onSignedIn,
}: SignInPromptProps) {
  const { signIn, connected } = useWallet()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn() {
    setPending(true)
    setError(null)
    const ok = await signIn()
    setPending(false)
    if (ok) {
      onSignedIn?.()
    } else {
      setError(
        connected
          ? "Signature declined. Try again to continue."
          : "Connect your wallet first, then sign in.",
      )
    }
  }

  return (
    <EmptyState
      icon={<Lock />}
      title={title}
      description={description}
      action={
        <div className="space-y-2">
          <Button onClick={handleSignIn} disabled={pending}>
            {pending ? "Signing…" : "Sign in"}
          </Button>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      }
    />
  )
}
