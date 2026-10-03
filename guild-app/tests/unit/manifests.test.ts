import { describe, it, expect } from "vitest";
import {
  mintAgentBadgeManifest,
  recallAgentBadgeManifest,
  instantiateAgentBadgeControllerManifest,
  createTaskManifest,
  claimTaskManifest,
  submitTaskManifest,
  approveAndReleaseManifest,
  cancelTaskManifest,
  cancelTaskAfterClaimManifest,
  raiseDisputeManifest,
  expireClaimManifest,
  registerAcceptedTokenManifest,
  resolveDisputeManifest,
  autoResolveDisputeManifest,
  releaseAfterReviewTimeoutManifest,
  giftXrdManifest,
} from "../../src/lib/manifests";

// Real-format dummy addresses long enough to pass the `[a-z0-9]{20,}` check
const OWNER_ACCOUNT =
  "account_rdx12y4l35lh2543nff3dzqr93gz05aaftfagcgjm96xyn3m684rgawqsv35gm";
const OWNER_BADGE =
  "resource_rdx1n22hp6ydy0lkl0vqrk20cge43cm0lr64v9bldqzhq60g89fnp7j7s9";
const CONTROLLER =
  "component_rdx1cz63u8z4tt2ezw83vwsmfsfp4eahnxg59w8wts5gznz7v5gx5szyqd";
const AGENT_ACCOUNT =
  "account_rdx128lggtfnpqedz3vrjpxsq3w9zhwwpekklnm8vnzcfvp35cd8cx00gqmf";
const AGENT_BADGE_RESOURCE =
  "resource_rdx1nfaaqzaz9q5mt2ksexkrl6w8nfm99wmlcw2vc2eet6urep0kr00v5w";
const AGENT_VAULT =
  "internal_vault_rdx1tz9mhssxrjjk25qxs2vzpdyrqt5c8aaktnvgjz72c4qxk5j3y5x86kf";
const PACKAGE =
  "package_rdx1pksexample1234567890abcdefghijklmnopqrstuvwxyz0";

describe("mintAgentBadgeManifest", () => {
  it("produces the expected 3-instruction structure", () => {
    const m = mintAgentBadgeManifest(
      CONTROLLER,
      OWNER_ACCOUNT,
      OWNER_BADGE,
      AGENT_ACCOUNT,
      "alice_agent",
      AGENT_ACCOUNT,
      "100",
      "500",
    );
    expect(m).toContain(`Address("${OWNER_ACCOUNT}")`);
    expect(m).toContain(`"create_proof_of_amount"`);
    expect(m).toContain(`Address("${OWNER_BADGE}")`);
    expect(m).toContain(`Address("${CONTROLLER}")`);
    expect(m).toContain(`"mint_agent_badge"`);
    expect(m).toContain(`"alice_agent"`);
    expect(m).toContain(`Decimal("100")`);
    expect(m).toContain(`Decimal("500")`);
    expect(m).toContain(`Address("${AGENT_ACCOUNT}")`);
    expect(m).toContain(`Expression("ENTIRE_WORKTOP")`);
    // The OWNER signs (instruction 0 proves the owner badge), so the agent is a
    // non-signer and the owner-restricted deposit_batch would revert the whole tx
    // with an AuthError. This assertion previously pinned that broken shape.
    expect(m).toContain(`"try_deposit_batch_or_abort"`);
    expect(m).not.toContain(`"deposit_batch"`);
  });

  it("strips injection attempts from agent_name", () => {
    const m = mintAgentBadgeManifest(
      CONTROLLER,
      OWNER_ACCOUNT,
      OWNER_BADGE,
      AGENT_ACCOUNT,
      `evil"; CALL_METHOD Address("rogue") "drain"; "x`,
      AGENT_ACCOUNT,
      "100",
      "500",
    );
    expect(m).not.toContain(`CALL_METHOD\n  Address("rogue")`);
    expect(m).not.toContain(`"drain"`);
    // sanitize() strips quotes and semicolons → injection collapses into a
    // harmless string literal inside the agent_name argument (parens survive
    // but are inert inside a quoted string)
    expect(m).toContain(`"evil CALL_METHOD Address(rogue) drain x"`);
  });

  it("rejects invalid controller address prefix", () => {
    expect(() =>
      mintAgentBadgeManifest(
        "account_rdx12wrongprefix0000000000000000000000000000000",
        OWNER_ACCOUNT,
        OWNER_BADGE,
        AGENT_ACCOUNT,
        "alice",
        AGENT_ACCOUNT,
        "100",
        "500",
      ),
    ).toThrow(/component_rdx/);
  });

  it("rejects empty agent_name (after sanitization)", () => {
    expect(() =>
      mintAgentBadgeManifest(
        CONTROLLER,
        OWNER_ACCOUNT,
        OWNER_BADGE,
        AGENT_ACCOUNT,
        '";;""',
        AGENT_ACCOUNT,
        "100",
        "500",
      ),
    ).toThrow(/agent_name/);
  });

  it("rejects non-decimal spending_limit_per_task", () => {
    expect(() =>
      mintAgentBadgeManifest(
        CONTROLLER,
        OWNER_ACCOUNT,
        OWNER_BADGE,
        AGENT_ACCOUNT,
        "alice",
        AGENT_ACCOUNT,
        "100; rogue",
        "500",
      ),
    ).toThrow(/spending_limit_per_task/);
  });

  it("rejects negative-shaped daily_spending_cap", () => {
    expect(() =>
      mintAgentBadgeManifest(
        CONTROLLER,
        OWNER_ACCOUNT,
        OWNER_BADGE,
        AGENT_ACCOUNT,
        "alice",
        AGENT_ACCOUNT,
        "100",
        "-500",
      ),
    ).toThrow(/daily_spending_cap/);
  });
});

describe("recallAgentBadgeManifest", () => {
  it("produces the expected 4-instruction structure", () => {
    const m = recallAgentBadgeManifest(
      AGENT_BADGE_RESOURCE,
      AGENT_VAULT,
      OWNER_ACCOUNT,
      OWNER_BADGE,
      42,
    );
    expect(m).toContain(`Address("${OWNER_ACCOUNT}")`);
    expect(m).toContain(`"create_proof_of_amount"`);
    expect(m).toContain(`Address("${OWNER_BADGE}")`);
    expect(m).toContain(`RECALL_NON_FUNGIBLES_FROM_VAULT`);
    expect(m).toContain(`Address("${AGENT_VAULT}")`);
    expect(m).toContain(`NonFungibleLocalId("#42#")`);
    expect(m).toContain(`TAKE_ALL_FROM_WORKTOP`);
    expect(m).toContain(`Address("${AGENT_BADGE_RESOURCE}")`);
    expect(m).toContain(`Bucket("recalled_badge")`);
    expect(m).toContain(`BURN_RESOURCE`);
  });

  it("rejects invalid vault address prefix", () => {
    expect(() =>
      recallAgentBadgeManifest(
        AGENT_BADGE_RESOURCE,
        "resource_rdx1wrongprefix0000000000000000000000000000",
        OWNER_ACCOUNT,
        OWNER_BADGE,
        42,
      ),
    ).toThrow(/internal_vault_rdx/);
  });

  it("rejects zero badge id", () => {
    expect(() =>
      recallAgentBadgeManifest(
        AGENT_BADGE_RESOURCE,
        AGENT_VAULT,
        OWNER_ACCOUNT,
        OWNER_BADGE,
        0,
      ),
    ).toThrow(/badgeId/);
  });

  it("rejects negative badge id", () => {
    expect(() =>
      recallAgentBadgeManifest(
        AGENT_BADGE_RESOURCE,
        AGENT_VAULT,
        OWNER_ACCOUNT,
        OWNER_BADGE,
        -1,
      ),
    ).toThrow(/badgeId/);
  });

  it("rejects fractional badge id", () => {
    expect(() =>
      recallAgentBadgeManifest(
        AGENT_BADGE_RESOURCE,
        AGENT_VAULT,
        OWNER_ACCOUNT,
        OWNER_BADGE,
        1.5,
      ),
    ).toThrow(/badgeId/);
  });
});

describe("instantiateAgentBadgeControllerManifest", () => {
  it("produces CALL_FUNCTION + deposit_batch", () => {
    const m = instantiateAgentBadgeControllerManifest(PACKAGE, OWNER_ACCOUNT);
    expect(m).toContain(`CALL_FUNCTION`);
    expect(m).toContain(`Address("${PACKAGE}")`);
    expect(m).toContain(`"AgentBadgeController"`);
    expect(m).toContain(`"instantiate"`);
    expect(m).toContain(`Address("${OWNER_ACCOUNT}")`);
    expect(m).toContain(`"deposit_batch"`);
    expect(m).toContain(`Expression("ENTIRE_WORKTOP")`);
  });

  it("rejects non-package address prefix", () => {
    expect(() =>
      instantiateAgentBadgeControllerManifest(
        "component_rdx1wrongprefix000000000000000000000",
        OWNER_ACCOUNT,
      ),
    ).toThrow(/package_rdx/);
  });
});

// ── Escrow lifecycle builders (deployed `Escrow` singleton) ──────────────────

const ESCROW =
  "component_rdx1cz9mh49guszgssxwwsnvh47ug5lgkhtjqtfc0sp0gr2q6qy6t796s7";
const POSTER = OWNER_ACCOUNT;
const WORKER = AGENT_ACCOUNT;
const RECEIPT_RES =
  "resource_rdx1ng7a6qumntg7pmx0vygqdpzdsgvdqwjw6m9dap56ck53xglvwf49ml";
const CLAIM_RES =
  "resource_rdx1ngw66k0q9gcrc55lesr98m47excg99l49excakfhfad775qkk6k8kn";
const BADGE_RES =
  "resource_rdx1n22rq94kh6ugwnrvc65m2pwhle3s6ez6j7702vkn2ctkaxemz4ppwl";
const XRD =
  "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";
const HASH = "a".repeat(64);

describe("createTaskManifest", () => {
  it("calls create_task on the COMPONENT with poster, buckets, fee, Bytes(hash)", () => {
    const m = createTaskManifest(ESCROW, POSTER, 500, 25, "0", HASH);
    expect(m).toContain(`Address("${ESCROW}")`);
    expect(m).toContain(`"create_task"`);
    expect(m).toContain(`Address("${POSTER}")`); // poster arg (#1)
    expect(m).toContain(`Bucket("reward")`);
    expect(m).toContain(`Bucket("insurance")`);
    expect(m).toContain(`Decimal("0")`); // arbiter_fee_pct
    expect(m).toContain(`Bytes("${HASH}")`); // work_brief_hash
    expect(m).toContain(`Decimal("500")`);
    expect(m).toContain(`Decimal("25")`);
    expect(m).toContain(`"deposit_batch"`);
  });

  it("uses the canonical mainnet XRD (…radxrd, NOT …stcfkr) and no old constructor call", () => {
    const m = createTaskManifest(ESCROW, POSTER, 500, 25, "0", HASH);
    expect(m).toContain(`Address("${XRD}")`);
    expect(m).not.toContain("stcfkr");
    // regression: old builder used CALL_FUNCTION <pkg> "GuildEscrow"
    expect(m).not.toContain("CALL_FUNCTION");
    expect(m).not.toContain("GuildEscrow");
  });

  it("rejects a non-component escrow address", () => {
    expect(() => createTaskManifest(POSTER, POSTER, 500, 25, "0", HASH)).toThrow(
      /component_rdx/,
    );
  });

  it("rejects a malformed work_brief_hash", () => {
    expect(() => createTaskManifest(ESCROW, POSTER, 500, 25, "0", "xyz")).toThrow(
      /workBriefHash/,
    );
  });

  it("rejects an injection-shaped arbiter fee", () => {
    expect(() =>
      createTaskManifest(ESCROW, POSTER, 500, 25, "0; CALL_METHOD", HASH),
    ).toThrow(/arbiterFeePct/);
  });
});

describe("claimTaskManifest", () => {
  // Wave B: the bond is the TASK'S REWARD TOKEN at a computed amount, not a
  // flat 10 XRD. These fixtures use a non-XRD resource deliberately — under the
  // old builder every claim manifest named XRD no matter what, so a test using
  // XRD here could not tell the ported builder from the flat one.
  const BOND_RES = "resource_rdx1t4dy69k6s0gv040xkv6rejxrmljfhrqmpad5hh4pdgvtjs4tvag5uf";
  const BOND_AMT = "12.5";

  it("withdraws the claim_bond, proves the badge, calls claim_task(task_id, worker, proof, bond)", () => {
    const m = claimTaskManifest(ESCROW, WORKER, BADGE_RES, "#5#", 7, BOND_RES, BOND_AMT);
    expect(m).toContain(`Decimal("12.5")`); // claim_bond
    expect(m).toContain(`Bucket("claim_bond")`);
    expect(m).toContain(`"create_proof_of_non_fungibles"`);
    expect(m).toContain(`NonFungibleLocalId("#5#")`);
    expect(m).toContain(`Proof("worker_proof")`);
    expect(m).toContain(`"claim_task"`);
    expect(m).toContain(`7u64`);
    expect(m).toContain(`Address("${WORKER}")`);
  });

  it("withdraws the BOND RESOURCE, not XRD — the flat-XRD builder is gone", () => {
    // The regression this port exists to prevent, asserted as a property rather
    // than described in a comment: the pre-Wave-B builder hardcoded XRD, so at
    // the swap ceremony every claim from the site would have reverted on
    // `claim_bond amount does not match required`. Restore the hardcoded XRD
    // resource in claimTaskManifest and this test fails.
    const m = claimTaskManifest(ESCROW, WORKER, BADGE_RES, "#5#", 7, BOND_RES, BOND_AMT);
    expect(m).toContain(`Address("${BOND_RES}")`);
    expect(m).not.toContain(XRD);
  });

  it("rejects a malformed badge local id", () => {
    expect(() => claimTaskManifest(ESCROW, WORKER, BADGE_RES, 'bad"; x', 7, BOND_RES, BOND_AMT)).toThrow(
      /badgeLocalId/,
    );
  });

  it("rejects a malformed bond resource", () => {
    // validateAddress names the ADDRESS TYPE, not the parameter — asserting
    // /bondResource/ here failed, and the code was right both times.
    expect(() =>
      claimTaskManifest(ESCROW, WORKER, BADGE_RES, "#5#", 7, "not-a-resource", BOND_AMT),
    ).toThrow(/Invalid resource_rdx address/);
  });

  it("rejects a bond amount that is not a plain decimal string", () => {
    // The amount arrives as a STRING from requiredBond's integer arithmetic.
    // Anything float-shaped or exponential must not reach the manifest.
    for (const bad of ["1e18", "", "abc", "-5", "1.2.3"]) {
      expect(() =>
        claimTaskManifest(ESCROW, WORKER, BADGE_RES, "#5#", 7, BOND_RES, bad),
      ).toThrow(/bondAmount/);
    }
  });

  it("rejects a bond amount finer than the chain's 18dp", () => {
    expect(() =>
      claimTaskManifest(ESCROW, WORKER, BADGE_RES, "#5#", 7, BOND_RES, "0." + "1".repeat(19)),
    ).toThrow(/exceeds the chain's 18/);
  });
});

describe("submitTaskManifest", () => {
  it("withdraws the claim receipt as a Bucket + Bytes(evidence) + Bytes(brief)", () => {
    // Wave B stage 6: submit_task is 4 args now (task_id, claim_receipt,
    // evidence_hash, brief_hash) — distinct hash values below so a positional
    // swap between the two would not go unnoticed.
    const ev = "b".repeat(64);
    const brief = "c".repeat(64);
    const m = submitTaskManifest(ESCROW, WORKER, CLAIM_RES, 3, 7, ev, brief);
    expect(m).toContain(`"withdraw_non_fungibles"`);
    expect(m).toContain(`NonFungibleLocalId("#3#")`);
    expect(m).toContain(`Bucket("claim_receipt")`);
    expect(m).toContain(`"submit_task"`);
    expect(m).toContain(`7u64`);
    expect(m).toContain(`Bytes("${ev}")`);
    expect(m).toContain(`Bytes("${brief}")`);
    // Order matters: evidence_hash before brief_hash, matching lib.rs.
    expect(m.indexOf(`Bytes("${ev}")`)).toBeLessThan(m.indexOf(`Bytes("${brief}")`));
  });
});

describe("releaseAfterReviewTimeoutManifest (public keeper, Wave B stage 6)", () => {
  it("is a bare trigger: one call, task id only, nothing else", () => {
    const m = releaseAfterReviewTimeoutManifest(ESCROW, 7);
    expect(m).toBe(`CALL_METHOD
  Address("${ESCROW}")
  "release_after_review_timeout"
  7u64
;`);
  });

  it("carries no account address at all — the caller cannot route or receive", () => {
    // Pays exactly what approve_and_release pays, by CREDITING entitlements on
    // the component; parties collect via withdraw_worker / withdraw_poster.
    const m = releaseAfterReviewTimeoutManifest(ESCROW, 7);
    expect(m).not.toContain("account_rdx");
    expect(m).not.toContain("TAKE_FROM_WORKTOP");
    expect(m).not.toContain("deposit");
  });

  it("rejects a non-positive or unsafe task id", () => {
    expect(() => releaseAfterReviewTimeoutManifest(ESCROW, 0)).toThrow();
    expect(() => releaseAfterReviewTimeoutManifest(ESCROW, -1)).toThrow();
  });
});

// ── PULL forms (canonical — what the app signs once FLAGS.escrowPull is on) ───
//
// The directional assertions (`not.toContain`) are the point: each one is the
// exact shape that shipped broken on 2026-08-09 (Bucket where the blueprint
// takes Proof) or the dead plumbing that came with it. The ABI gate
// (manifest-abi-gate.test.ts) checks the same class structurally; these pin the
// full instruction shape.

describe("approveAndReleaseManifest (PULL)", () => {
  it("presents the receipt as a PROOF and calls approve_and_release — nothing else", () => {
    const m = approveAndReleaseManifest(ESCROW, POSTER, RECEIPT_RES, 7);
    expect(m).toContain(`"create_proof_of_non_fungibles"`);
    expect(m).toContain(`NonFungibleLocalId("#7#")`);
    expect(m).toMatch(/"approve_and_release"\s*\n\s*Proof\("receipt_proof"\)/);
    // The push shape, byte-negated. approve_and_release returns (), so a
    // withdraw/Bucket/route/deposit is not merely redundant — the Bucket form
    // is a BlueprintPayloadValidationError (mainnet preview, 2026-08-09), and
    // a TAKE_FROM_WORKTOP would fail against an empty worktop.
    expect(m).not.toContain("withdraw_non_fungibles");
    expect(m).not.toContain("Bucket(");
    expect(m).not.toContain("TAKE_FROM_WORKTOP");
    expect(m).not.toContain("try_deposit_or_abort");
    expect(m).not.toContain("deposit_batch");
  });

  it("carries NO amount and NO worker account — the blueprint routes both", () => {
    // Under pull the caller cannot choose the payee or the amount; a manifest
    // that mentions either is push-shaped and wrong.
    const m = approveAndReleaseManifest(ESCROW, POSTER, RECEIPT_RES, 7);
    expect(m).not.toContain("Decimal(");
    expect(m).not.toContain(WORKER);
  });
});

describe("cancelTaskManifest (PULL)", () => {
  it("presents the receipt as a PROOF; refund is an entitlement, not a worktop leg", () => {
    const m = cancelTaskManifest(ESCROW, POSTER, RECEIPT_RES, 7);
    expect(m).toContain(`"create_proof_of_non_fungibles"`);
    expect(m).toMatch(/"cancel_task"\s*\n\s*Proof\("receipt_proof"\)/);
    expect(m).not.toContain("Bucket(");
    expect(m).not.toContain("deposit_batch");
  });
});

describe("cancelTaskAfterClaimManifest (PULL)", () => {
  it("task id + receipt PROOF; the bond is the blueprint's to credit, not ours to route", () => {
    const m = cancelTaskAfterClaimManifest(ESCROW, POSTER, RECEIPT_RES, 7);
    expect(m).toContain(`"cancel_task_by_poster_after_claim"`);
    expect(m).toMatch(/7u64\s*\n\s*Proof\("receipt_proof"\)/);
    // The push form took workerAccount + claimBondXrd and split the bond off
    // the worktop. Under pull a caller-chosen bond leg is exactly the sweep
    // class H1 was — the blueprint pins the payee instead.
    expect(m).not.toContain("Bucket(");
    expect(m).not.toContain("Decimal(");
    expect(m).not.toContain(WORKER);
    expect(m).not.toContain("deposit_batch");
  });
});

describe("raiseDisputeManifest", () => {
  it("encodes no-evidence as Option::None → Enum<0u8>()", () => {
    const m = raiseDisputeManifest(ESCROW, POSTER, RECEIPT_RES, "#7#", 7, null);
    expect(m).toContain(`"raise_dispute"`);
    expect(m).toContain(`7u64`);
    expect(m).toContain(`Proof("party_proof")`);
    expect(m).toContain(`Enum<0u8>()`);
  });

  it("encodes evidence as Option::Some(Hash) → Enum<1u8>(Bytes(…))", () => {
    const ev = "c".repeat(64);
    const m = raiseDisputeManifest(ESCROW, POSTER, RECEIPT_RES, "#7#", 7, ev);
    expect(m).toContain(`Enum<1u8>(Bytes("${ev}"))`);
  });
});

describe("expireClaimManifest", () => {
  it("is a public call with no withdrawals; the caller deposits the DB-4 bounty to itself", () => {
    const m = expireClaimManifest(ESCROW, WORKER, 7);
    expect(m).toContain(`"expire_claim"`);
    expect(m).toContain(`7u64`);
    // No funds FROM the caller — the deposit leg is the caller RECEIVING the
    // min(1 XRD, bond) bounty the method returns (DB-4, sitting 2026-08-06).
    expect(m).not.toContain("withdraw");
    expect(m).toContain(`Address("${WORKER}")`);
    expect(m).toContain(`"deposit_batch"`);
  });
});

describe("registerAcceptedTokenManifest", () => {
  it("proves the owner badge then calls add_accepted_token", () => {
    const m = registerAcceptedTokenManifest(ESCROW, OWNER_ACCOUNT, OWNER_BADGE, XRD, 10);
    expect(m).toContain(`"create_proof_of_amount"`);
    expect(m).toContain(`Address("${OWNER_BADGE}")`);
    expect(m).toContain(`"add_accepted_token"`);
    expect(m).toContain(`Address("${XRD}")`);
    expect(m).toContain(`Decimal("10")`);
  });
});

// Distinct third party for dispute tests (POSTER=OWNER_ACCOUNT, WORKER=AGENT_ACCOUNT)
const ARBITER =
  "account_rdx12y4l35lh2543nff3dzqr93gz05aaftfagcgjm96xyn3m684rgawqsv35aa";

describe("resolveDisputeManifest (arbiter, PULL)", () => {
  it("badge as PROOF (the Wave B badge is non-transferable), fee to the arbiter — no share legs", () => {
    const m = resolveDisputeManifest(ESCROW, ARBITER, BADGE_RES, "#3#", 7, { kind: "PayWorker" });
    expect(m).toContain(`"create_proof_of_non_fungibles"`);
    expect(m).toContain(`NonFungibleLocalId("#3#")`);
    expect(m).toContain(`Proof("arbiter_proof")`);
    expect(m).toContain(`"resolve_dispute"`);
    expect(m).toContain(`7u64`);
    expect(m).toContain(`Enum<0u8>()`); // PayWorker
    expect(m).toContain(`Expression("ENTIRE_WORKTOP")`); // fee → arbiter
    // 🔴 The Bucket form must NEVER come back: the ceremony badge has
    // withdrawer DenyAll, so a withdraw-based manifest is physically
    // uncallable against it — it shipped that way once and was caught at
    // ceremony prep, not by a test. These two asserts are the tripwire.
    expect(m).not.toContain(`"withdraw_non_fungibles"`);
    expect(m).not.toContain(`Bucket("arbiter_badge")`);
    // PULL: the parties' shares are credited on the component, never routed by
    // the caller — no exact TAKE legs, no counterparty deposits, no accounts
    // other than the arbiter's own.
    expect(m).not.toContain("TAKE_FROM_WORKTOP");
    expect(m).not.toContain(`Bucket("worker_share")`);
    expect(m).not.toContain(`Bucket("poster_share")`);
    expect(m).not.toContain("try_deposit_or_abort");
    expect(m).not.toContain(WORKER);
    expect(m).not.toContain(POSTER);
  });

  it("Split: encodes Enum<2u8>(Decimal,Decimal) — still no routing", () => {
    const m = resolveDisputeManifest(
      ESCROW, ARBITER, BADGE_RES, "#3#", 7,
      { kind: "Split", workerPct: "0.6", posterPct: "0.4" },
    );
    expect(m).toContain(`Enum<2u8>(Decimal("0.6"), Decimal("0.4"))`);
    expect(m).not.toContain("TAKE_FROM_WORKTOP");
  });

  it("RefundPoster encodes Enum<1u8>()", () => {
    const m = resolveDisputeManifest(ESCROW, ARBITER, BADGE_RES, "#3#", 7, { kind: "RefundPoster" });
    expect(m).toContain(`Enum<1u8>()`);
  });

  it("rejects a malformed Split percentage", () => {
    expect(() =>
      resolveDisputeManifest(
        ESCROW, ARBITER, BADGE_RES, "#3#", 7,
        { kind: "Split", workerPct: "0.6; rogue", posterPct: "0.4" },
      ),
    ).toThrow(/workerPct/);
  });
});

describe("autoResolveDisputeManifest (public keeper, PULL)", () => {
  it("is a bare trigger: one call, task id only, nothing else", () => {
    const m = autoResolveDisputeManifest(ESCROW, 7);
    expect(m).toBe(`CALL_METHOD
  Address("${ESCROW}")
  "auto_resolve_dispute"
  7u64
;`);
  });

  it("carries no account address at all — the caller cannot route or receive", () => {
    // auto_resolve_dispute returns (); entitlements credit on the component
    // and parties collect via withdraw_worker / withdraw_poster. Any account
    // in this manifest would be a routing surface that pull exists to remove.
    const m = autoResolveDisputeManifest(ESCROW, 7);
    expect(m).not.toContain("account_rdx");
    expect(m).not.toContain("TAKE_FROM_WORKTOP");
    expect(m).not.toContain("deposit");
  });

  it("rejects a non-positive or unsafe task id", () => {
    expect(() => autoResolveDisputeManifest(ESCROW, 0)).toThrow(/taskId/);
    expect(() => autoResolveDisputeManifest(ESCROW, 2 ** 53)).toThrow(/taskId/);
  });

  it("rejects a malformed component address (injection guard)", () => {
    expect(() =>
      autoResolveDisputeManifest(`${ESCROW}")\n;CALL_METHOD`, 7),
    ).toThrow(/component_rdx/);
  });
});

describe("giftXrdManifest", () => {
  it("withdraws from the donor and try_deposit_or_aborts to the gift account", () => {
    const m = giftXrdManifest(POSTER, WORKER, 500);
    expect(m).toContain(`CALL_METHOD
  Address("${POSTER}")
  "withdraw"
  Address("${XRD}")
  Decimal("500")
;`);
    expect(m).toContain(`TAKE_FROM_WORKTOP
  Address("${XRD}")
  Decimal("500")
  Bucket("gift")
;`);
    expect(m).toContain(`CALL_METHOD
  Address("${WORKER}")
  "try_deposit_or_abort"
  Bucket("gift")
  Enum<0u8>()
;`);
  });

  it("uses the canonical mainnet XRD (…radxrd, NOT …stcfkr)", () => {
    const m = giftXrdManifest(POSTER, WORKER, 100);
    expect(m).toContain(`Address("${XRD}")`);
    expect(m).not.toContain("stcfkr");
  });

  it("is a plain transfer — it touches no component and mints no receipt", () => {
    // A gift buys nothing, so it must not call into escrow or anything else.
    const m = giftXrdManifest(POSTER, WORKER, 100);
    expect(m).not.toContain("component_rdx");
    expect(m).not.toContain("CALL_FUNCTION");
    expect(m).not.toContain("create_task");
    expect(m).not.toContain("deposit_batch");
  });

  it("takes the EXACT amount from the worktop, never TAKE_ALL", () => {
    const m = giftXrdManifest(POSTER, WORKER, 100);
    expect(m).not.toContain("TAKE_ALL_FROM_WORKTOP");
    expect(m).toContain(`Decimal("100")`);
  });

  it.each([
    ["a non-account sender", () => giftXrdManifest(ESCROW, WORKER, 100), /account_rdx/],
    ["a non-account recipient", () => giftXrdManifest(POSTER, ESCROW, 100), /account_rdx/],
    ["a self-send (wasted fees, no-op)", () => giftXrdManifest(POSTER, POSTER, 100), /same account/],
    ["a zero amount", () => giftXrdManifest(POSTER, WORKER, 0), /must be positive/],
    ["a negative amount", () => giftXrdManifest(POSTER, WORKER, -5), /must not be negative/],
    ["a NaN amount", () => giftXrdManifest(POSTER, WORKER, NaN), /finite number/],
    ["an exponential amount", () => giftXrdManifest(POSTER, WORKER, 1e21), /out of supported range/],
  ])("rejects %s", (_label, fn, pattern) => {
    expect(fn).toThrow(pattern);
  });
});

/**
 * The 18dp ceiling — mirrored verbatim from
 * packages/agent-client/src/manifests.hardening.test.ts, because `decimalArg`
 * exists in BOTH packages and byte-parity only compares the manifests the
 * builders EMIT. A validator that rejects in one package and passes in the other
 * produces no parity failure at all: the client would simply build a manifest
 * the server refuses to, and the divergence would surface as an agent-only bug.
 *
 * Radix `Decimal` is fixed-point at 18dp. Below ~1e-6 a double keeps its
 * non-exponential string form while carrying its binary residue, so ordinary
 * arithmetic reaches the emitter with more decimal places than the chain can
 * represent — and the chain truncates them, so the manifest text claims one
 * amount while the ledger moves another.
 */
describe("decimalArg — the chain cannot represent more than 18dp", () => {
  // Vehicle changed 2026-09-02: claimTaskManifest's bond became a STRING at the
  // Wave B port, so it can no longer exercise decimalArg. createTaskManifest's
  // rewardXrd still takes a number and still routes through decimalArg, so the
  // property under test is unchanged — only the caller moved.
  const bond = (n: number) => createTaskManifest(ESCROW, WORKER, n, 1, "0", "aa".repeat(32));

  it("0.1 ** 6 (22 decimal places, non-exponential) throws instead of emitting", () => {
    expect(String(0.1 ** 6).split(".")[1]!.length).toBe(22);
    expect(() => bond(0.1 ** 6)).toThrow(/exceeds the chain's 18/);
  });

  it("the rejection names the count and the cause", () => {
    expect(() => bond(0.1 ** 6)).toThrow(/22 decimal places/);
    expect(() => bond(0.1 ** 6)).toThrow(/never the result of float arithmetic/);
  });

  it("17dp still passes — the documented float-artifact boundary did not move", () => {
    expect(() => bond(0.1 + 0.2)).not.toThrow();
  });

  it("ordinary whole and 2dp amounts are untouched", () => {
    expect(() => bond(10)).not.toThrow();
    expect(() => bond(10.25)).not.toThrow();
    expect(bond(10)).toContain('Decimal("10")');
  });

  it("never emits a Decimal with more than 18 decimal places", () => {
    // The property, stated directly rather than by example.
    for (const n of [10, 10.25, 0.1 + 0.2, 1.5, 105]) {
      for (const d of bond(n).matchAll(/Decimal\("([\d.]+)"\)/g)) {
        expect((d[1].split(".")[1] ?? "").length).toBeLessThanOrEqual(18);
      }
    }
  });
});
