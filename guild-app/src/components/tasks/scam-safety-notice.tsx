import { ShieldAlert } from "lucide-react"
import { TG_BOT_HANDLE, TG_BOT_URL, TG_GROUP_URL } from "@/lib/config"

// One short, always-on warning on every task page, beside the buttons that
// move money. The scams this is aimed at never touch the escrow: a DM posing as
// the Guild asking for XRD "to release payment", a fake site asking the wallet
// to connect, a request for a seed phrase. The escrow cannot see those, so the
// only defence the site can offer is saying plainly, where people act, what a
// real payout looks like and who the Guild's accounts are.
//
// Every sentence is a fact about the product, checked 2026-09-24:
//   - "only ever comes out of the escrow": every payout path is a withdrawal
//     from the escrow component (withdraw_worker / withdraw_poster /
//     push_entitlement in escrow/scrypto/guild-marketplace-escrow/src/lib.rs).
//   - "the only XRD you send goes into it": claim_task takes the bond, and
//     create_task takes the reward and insurance; nothing else asks for XRD.
//   - "Nobody from the Guild will ask…": the operator's commitment, the same one
//     the pinned group message, the bot (guild-public #171) and /trust carry.
//     Delete it the day it stops being true.
//   - Reports go to a NAMED account: "the admin" is exactly what an impersonator
//     copies, and scam details do not belong in a public group first.
const OPERATOR_TG_URL = "https://t.me/bigdev_xrd"
// Handles come from config.ts (tests/unit/telegram-bot-vs-group-links.test.ts).
const GROUP_HANDLE = `@${TG_GROUP_URL.split("/").pop()}`

export function ScamSafetyNotice() {
  const link = "underline underline-offset-2"
  return (
    <div className="space-y-1.5 rounded-md border px-3 py-2 text-xs text-muted-foreground">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        Stay safe
      </p>
      <p>
        Payment for a task only ever comes out of the escrow, and apart from network fees the only
        XRD you send goes into it: a claim bond when you claim, the reward and insurance when you
        fund.
      </p>
      <p>
        Nobody from the Guild will ask for your seed phrase, ask you to send XRD anywhere by hand,
        or ask you to connect your wallet anywhere but radixguild.com. Before you sign, read what
        your Radix Wallet says will leave your account.
      </p>
      <p>
        Seen something that looks like a scam? Message{" "}
        <a href={OPERATOR_TG_URL} className={link} rel="noopener noreferrer">@bigdev_xrd</a> or post in
        the{" "}
        <a href={TG_GROUP_URL} className={link} rel="noopener noreferrer">Guild group, {GROUP_HANDLE}</a>.
        Those two and the bot{" "}
        <a href={TG_BOT_URL} className={link} rel="noopener noreferrer">{TG_BOT_HANDLE}</a> are the
        Guild&apos;s only Telegram accounts.
      </p>
    </div>
  )
}
