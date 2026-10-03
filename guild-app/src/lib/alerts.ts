/**
 * Operator alerts — the stateful front door.
 *
 *   evaluateAlert({ key, condition, title, detail, inhibitedBy })
 *
 * Call it with the condition as observed RIGHT NOW, every time you observe it
 * (true or false). The policy (alert-policy.ts) turns that stream of
 * observations into exactly the messages an operator wants: one raise, silent
 * reminders at 1h/6h/24h then daily, one recovery notice — and nothing while a
 * parent incident already explains it. The store (alert-store.ts) makes that
 * hold across restarts and concurrent requests.
 *
 * The healthy-path call (condition=false) is what produces the recovery
 * notice, so do not skip it. It is cheap: a cached read while nothing is open.
 *
 * Never throws — alerting must never break the request or the job that
 * observed the condition. Returns what happened so tests can assert on it.
 */

import {
  createAlertEvaluator,
  humanDuration,
  type AlertInput as CoreAlertInput,
  type AlertOutcome,
} from "./alert-core";
import { defaultAlertStore, type AlertStore } from "./alert-store";
import { sendTelegramMessage } from "./tg-alert";
import {
  NETWORK_HALT_AFTER_SECONDS,
  type LedgerTip,
} from "./gateway";

export { humanDuration, formatAlert } from "./alert-core";
export type { AlertOutcome };

export interface AlertInput extends CoreAlertInput {
  /** Test seam; defaults to the Postgres store when DATABASE_URL is set, memory otherwise. */
  store?: AlertStore;
}

/** Incident key for "Radix mainnet is not producing rounds". */
export const NETWORK_HALT_ALERT_KEY = "network-halt";
/** Incident key for "we cannot read the Gateway at all". */
export const GATEWAY_UNREACHABLE_ALERT_KEY = "gateway-unreachable";

export async function evaluateAlert(input: AlertInput): Promise<AlertOutcome> {
  const { store, ...core } = input;
  const evaluate = createAlertEvaluator({
    store: store ?? defaultAlertStore(),
    send: (text, { silent }) => sendTelegramMessage(text, { silent }),
    onError: (err, key) => console.error("[alerts] store failure — alert not evaluated", { key, err }),
  });
  return evaluate(core);
}

/**
 * The network-halt incident, derived from the ledger tip the gateway module
 * already reads for the site banner. Two distinct facts, two keys:
 *   network-halt        the tip is old (rounds stopped) or the operator lever is on
 *   gateway-unreachable the live read failed and we are re-serving a remembered tip
 * They must not collapse into one — "the chain stopped" and "we cannot see the
 * chain" call for different actions.
 *
 * `tip === null` (never read a tip) raises nothing: a cold-start Gateway
 * hiccup must not page "mainnet halted". The operator lever stands on its own.
 */
export async function evaluateNetworkHalt(
  tip: LedgerTip | null,
  operatorHalt: boolean,
  opts: { now?: number; store?: AlertStore } = {},
): Promise<{ halt: AlertOutcome; gateway: AlertOutcome }> {
  const now = opts.now ?? Date.now();
  const store = opts.store;
  const gateway = await evaluateAlert({
    key: GATEWAY_UNREACHABLE_ALERT_KEY,
    condition: tip !== null && tip.stale,
    title: "Gateway unreachable — re-serving the last-known ledger tip",
    detail: tip
      ? `last-known tip ${tip.stateVersion} @ ${tip.tipIso}`
      : undefined,
    now,
    store,
  });
  if (tip === null && !operatorHalt) {
    return { halt: "none", gateway };
  }
  const halted = operatorHalt || (tip !== null && !tip.stale && tip.ageSeconds > NETWORK_HALT_AFTER_SECONDS);
  const knownNotHalted = !operatorHalt && tip !== null && !tip.stale && tip.ageSeconds <= NETWORK_HALT_AFTER_SECONDS;
  if (!halted && !knownNotHalted) {
    // Stale tip and no lever: we do not know. Leave the incident as it is.
    return { halt: "none", gateway };
  }
  const halt = await evaluateAlert({
    key: NETWORK_HALT_ALERT_KEY,
    condition: halted,
    title: "Radix mainnet halted — rounds have stopped",
    detail:
      (tip
        ? `ledger tip ${tip.stateVersion} @ ${tip.tipIso} (${humanDuration(tip.ageSeconds * 1000)} old)`
        : "no ledger tip readable") +
      (operatorHalt ? " · operator halt lever (GUILD_HALT) is ON" : "") +
      "\nChain-dependent alerts (price feed frozen, reconciler, drift) are inhibited while this is open and listed in its reminders.",
    now,
    store,
  });
  return { halt, gateway };
}
