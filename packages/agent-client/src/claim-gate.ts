// claim-gate.ts — the owner's money rules, checked before a personal agent
// bonds anything (docs/design/bring-your-agent.md §2.3):
//
//   • the bond must be in XRD — rules.maxBondXrd is an XRD amount, and a bond
//     in another token cannot be compared to it, so the claim is refused
//     rather than guessed (Wave B sizes the bond in the task's reward token);
//   • the bond must be at most rules.maxBondXrd;
//   • the balance must cover the bond plus FEE_RESERVE_XRD, so the cycle's
//     own transactions (claim, submit, withdraw, sweep) can always pay fees.
//
// Anything that cannot be read is a refusal for this tick, never a pass.
// Only `guild-agent run` sets a gate; the fleet's claim path is unchanged.
//
// These are CLIENT rules: until the server re-checks them (A3), they bind a
// kit that has not been modified, and the float is the backstop.

import { MAINNET_XRD, type GuildClientConfig } from './config.js';
import { fetchXrdBalanceExact } from './gateway.js';
import { scaleDecimal } from './manifests.js';
import { resolveClaimBond } from './tx.js';

export interface ClaimGate {
  /** Decimal XRD: the largest claim bond this agent may lock (rules.maxBondXrd). */
  maxBondXrd: string;
  /** Decimal XRD kept above the bond for the cycle's fees (FEE_RESERVE_XRD). */
  feeReserveXrd: string;
  /** Seams for tests; real defaults. */
  resolveBond?: typeof resolveClaimBond;
  readBalance?: typeof fetchXrdBalanceExact;
}

export type ClaimGateVerdict =
  | { ok: true; bondXrd: string; balanceXrd: string }
  | { ok: false; reason: string; balanceXrd?: string };

function xrd(value: string): bigint | null {
  if (!/^\d{1,30}(\.\d{1,18})?$/.test(value)) return null;
  return scaleDecimal(value);
}

export async function checkClaimGate(
  onChainTaskId: number,
  agentAddress: string,
  gate: ClaimGate,
  config: GuildClientConfig
): Promise<ClaimGateVerdict> {
  const resolveBond = gate.resolveBond ?? resolveClaimBond;
  const readBalance = gate.readBalance ?? fetchXrdBalanceExact;

  const max = xrd(gate.maxBondXrd);
  const reserve = xrd(gate.feeReserveXrd);
  if (max === null || reserve === null) {
    return { ok: false, reason: `the rules are malformed (maxBondXrd ${gate.maxBondXrd}, fee reserve ${gate.feeReserveXrd})` };
  }

  let bond: { resource: string; amount: string };
  try {
    bond = await resolveBond(onChainTaskId, config);
  } catch (error) {
    return { ok: false, reason: `the claim bond could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (bond.resource !== MAINNET_XRD) {
    return {
      ok: false,
      reason: `the claim bond is in ${bond.resource}, not XRD — maxBondXrd cannot be compared to it, so the claim is refused rather than guessed`,
    };
  }
  const bondAttos = xrd(bond.amount);
  if (bondAttos === null) return { ok: false, reason: `the claim bond (${bond.amount}) is not a decimal XRD amount` };
  if (bondAttos > max) {
    return { ok: false, reason: `the claim bond ${bond.amount} XRD is above the owner's maxBondXrd ${gate.maxBondXrd}` };
  }

  const balance = await readBalance(agentAddress, config.gatewayBaseUrl);
  if (balance === null) return { ok: false, reason: "this account's XRD balance could not be read" };
  const balanceAttos = xrd(balance);
  if (balanceAttos === null) return { ok: false, reason: `the XRD balance (${balance}) is not a decimal amount` };
  if (balanceAttos < bondAttos + reserve) {
    return {
      ok: false,
      reason: `the balance ${balance} XRD is under the bond ${bond.amount} + the ${gate.feeReserveXrd} XRD fee reserve`,
      balanceXrd: balance,
    };
  }
  return { ok: true, bondXrd: bond.amount, balanceXrd: balance };
}
