"use client"

// The web half of the Telegram bot's /link (src/lib/tg-link.ts). The bot DMs a
// person a link to here carrying a ticket for their TG id; they sign in with
// their wallet, press Continue, and send the code back to the bot.
//
// Nothing is issued on page load. The explicit Continue is the defence against
// the one attack this flow has: someone sends a victim THEIR OWN /link URL and
// asks for the code back, which would link the victim's wallet to the
// attacker's Telegram. The code only redeems from the ticket's TG id, so a
// victim who sends it to the bot themselves just gets "different account" —
// the warnings below say exactly that.

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SignInPrompt } from "@/components/wallet/sign-in-prompt"
import { CopyButton } from "@/components/copy-button"
import { apiFetch } from "@/lib/api-fetch"
import { TG_BOT_HANDLE, TG_BOT_URL } from "@/lib/config"

type State =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "signin" }
  | { kind: "error"; message: string }
  | { kind: "done"; code: string; minutes: number; address: string }

// Display only — the server verifies the ticket's signature before issuing anything.
function ticketTgId(ticket: string): number | null {
  try {
    const b64 = ticket.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    const tg = JSON.parse(atob(b64)).tg
    return Number.isSafeInteger(tg) ? tg : null
  } catch {
    return null
  }
}

function LinkTelegram() {
  const ticket = useSearchParams().get("t") ?? ""
  const tgId = ticket ? ticketTgId(ticket) : null
  const [state, setState] = useState<State>({ kind: "idle" })

  async function requestCode() {
    setState({ kind: "pending" })
    try {
      const res = await apiFetch("/api/v1/telegram/link-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      })
      if (res.status === 401) return setState({ kind: "signin" })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.ok) {
        return setState({ kind: "error", message: json?.error?.message ?? "Something went wrong. Try again." })
      }
      const minutes = Math.max(1, Math.round((json.data.expires_at * 1000 - Date.now()) / 60_000))
      setState({ kind: "done", code: json.data.code, minutes, address: json.data.address })
    } catch {
      setState({ kind: "error", message: "Couldn't reach the server. Try again." })
    }
  }

  if (!ticket || tgId === null) {
    return (
      <Alert>
        <AlertDescription>
          This page needs the link the Guild bot sends you. Open a private chat with{" "}
          <a className="underline" href={TG_BOT_URL}>{TG_BOT_HANDLE}</a> and send /link.
        </AlertDescription>
      </Alert>
    )
  }

  if (state.kind === "signin") {
    return (
      <SignInPrompt
        title="Sign in with your wallet"
        description="One signature proves you control the wallet. It moves no funds."
        onSignedIn={requestCode}
      />
    )
  }

  if (state.kind === "done") {
    const command = "/link " + state.code
    return (
      <Card>
        <CardHeader>
          <CardTitle>Send this to the bot yourself</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            In your private chat with <a className="underline" href={TG_BOT_URL}>{TG_BOT_HANDLE}</a>, send:
          </p>
          <pre className="whitespace-pre-wrap break-all rounded-md border bg-muted p-3 font-mono text-xs">{command}</pre>
          <CopyButton value={command} label="Copy" />
          <p className="text-muted-foreground">
            Links wallet …{state.address.slice(-8)} to Telegram id {tgId}. Works once, for about {state.minutes} minutes.
          </p>
          <Alert variant="destructive">
            <AlertDescription>
              Never give this code to anyone, and never paste it in a group. The Guild team will never ask you for it.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Link your wallet to Telegram</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>
          This proves to the Guild bot that you control your wallet, so /verify can vouch for it in the group.
        </p>
        <p>
          It links your wallet to <strong>Telegram id {tgId}</strong>. Continue only if you sent /link to the bot
          yourself just now. If someone else sent you this page, stop: it would link your wallet to their account.
        </p>
        {state.kind === "error" && (
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}
        <Button onClick={requestCode} disabled={state.kind === "pending"}>
          {state.kind === "pending" ? "Checking…" : "Continue"}
        </Button>
      </CardContent>
    </Card>
  )
}

export default function LinkTelegramPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-xl space-y-5">
        <h1 className="text-2xl font-bold">Link Telegram</h1>
        <Suspense fallback={null}>
          <LinkTelegram />
        </Suspense>
      </div>
    </AppShell>
  )
}
