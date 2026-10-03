// Content for /lights-on ("Who keeps the lights on?") — split into a typed
// data module, rather than written inline in the page, so the copy and the
// nine temperature-check questions are testable independently of rendering.
// The copy is VERBATIM from the approved draft (every sentence, heading,
// list and table): do not paraphrase when editing this file, and if a
// sentence needs to change, that is a copy decision, not a refactor.

export interface TempCheckOption {
  key: string
  label: string
}

export type CheckId = "q1" | "q2" | "q3a" | "q3b" | "q3c" | "q4" | "q5" | "q6" | "q7"

export const TEMP_CHECK_IDS: CheckId[] = ["q1", "q2", "q3a", "q3b", "q3c", "q4", "q5", "q6", "q7"]

export interface TempCheckDef {
  id: CheckId
  /** The question's own heading/lead-in line, verbatim (e.g. "1. Do we want
   *  the network up and maintained?" or, for the 3a/3b/3c sub-questions, the
   *  bold lead-in line itself, e.g. "3a. Would you run a validator, ...?"). */
  heading: string
  /** true for q1/q2/q4/q5/q6/q7, which are markdown `###` headings in the
   *  source; false for q3a/q3b/q3c, which are bold paragraph text nested
   *  under the "3. Are there willing participants?" heading. Rendering keeps
   *  this distinction rather than flattening every question to the same tag. */
  isMainHeading: boolean
  /** Body paragraph(s) between the heading and the option list, verbatim, in
   *  order. Empty when the heading line doubles as the question (q3a, q3b). */
  body: string[]
  options: TempCheckOption[]
}

export const TEMP_CHECKS: Record<CheckId, TempCheckDef> = {
  q1: {
    id: "q1",
    heading: "1. Do we want the network up and maintained?",
    isMainHeading: true,
    body: [
      "Do we, as a community, want three things kept alive for the next few years even if the price does not recover: the current network (nodes, engine releases, security fixes), the read side that wallets and apps depend on (the Gateway), and the test networks for the successor design (Xi'an)?",
    ],
    options: [
      { key: "all_three", label: "Yes, all three" },
      { key: "current_and_gateway", label: "The current network and the Gateway only" },
      { key: "successor_only", label: "Only the successor; let the current network wind down" },
      { key: "no", label: "No, and here is why" },
    ],
  },
  q2: {
    id: "q2",
    heading: "2. Is the guild a suitable venue to coordinate it?",
    isMainHeading: true,
    body: [
      "The guild runs an escrow task board with on-chain receipts. Its dispute path has only been exercised by us, not yet by strangers with a real dispute between them, and its public ledger of escrow settlements is live at /ledger. With that said: would a shared-infrastructure effort be better coordinated through the guild (or a variation of it), through a new body, or through the DAO once it exists?",
    ],
    options: [
      { key: "guild", label: "The guild, as the ledger and task board" },
      { key: "new_association", label: "A new members' association with its own name" },
      { key: "dao", label: "The Radix DAO, when it is ratified" },
      { key: "none", label: "None of these" },
    ],
  },
  q3a: {
    id: "q3a",
    heading:
      "3a. Would you run a validator, with a hot standby, on your own money, and list it in a public directory that shows your provider, region, fee and uptime?",
    isMainHeading: false,
    body: [],
    options: [
      { key: "already_run_one", label: "Yes, I already run one" },
      { key: "would_start_one", label: "Yes, I would start one" },
      { key: "only_if_hosting_covered", label: "Only if it covered its own hosting" },
      { key: "no", label: "No" },
    ],
  },
  q3b: {
    id: "q3b",
    heading:
      "3b. Would you pay a membership fee for shared infrastructure and the maintenance work that keeps it running, and at what level?",
    isMainHeading: false,
    body: [],
    options: [
      { key: "supporter", label: "Supporter, about $5 a month" },
      { key: "builder", label: "Builder, about $25 a month" },
      { key: "business", label: "Business, about $100 a month" },
      {
        key: "sponsor",
        label: "Sponsor, about $250 a month, buying seats for other members (never extra votes)",
      },
      { key: "no", label: "No" },
    ],
  },
  q3c: {
    id: "q3c",
    heading:
      "3c. Would you be a named, accountable person for this effort (a signatory for a hosting account, an association, or a Gateway arrangement)?",
    isMainHeading: false,
    body: [
      'This is a real legal role, not a title. It likely means your name on a hosting account, a bank account or a contract, with personal exposure if something goes wrong. Please do not answer "yes, publicly" without thinking that through.',
    ],
    options: [
      { key: "yes_publicly", label: "Yes, publicly" },
      { key: "yes_small_group", label: "Yes, to a small group" },
      { key: "no", label: "No" },
    ],
  },
  q4: {
    id: "q4",
    heading: "4. The radical option: XRD only, no outside money, for a set period",
    isMainHeading: true,
    body: [
      "This is separate from the membership dues in question 3. If the community wants dues, they would be paid and spent in XRD through the guild's own public ledger. This question is about money from outside: grants, token sales, fiat donations, anything raised.",
      "Would you support a commitment that this shared-infrastructure effort raises no outside money and sells nothing, settling only in XRD, for a fixed period? (The untested idea behind it: tooling built with nothing to sell gets tested harder. You may disagree.)",
    ],
    options: [
      { key: "one_year", label: "Yes, for at least a year" },
      { key: "two_years", label: "Yes, for at least two years" },
      { key: "only_if_funded_otherwise", label: "Only if maintenance is funded some other way" },
      { key: "no", label: "No" },
    ],
  },
  q5: {
    id: "q5",
    heading: "5. Who should hold the shared keys?",
    isMainHeading: true,
    body: [
      "If shared infrastructure exists, something has to hold the validator owner badges, the Gateway domain, and any membership dues held in common. Which shape do you prefer?",
    ],
    options: [
      {
        key: "no_entity",
        label: "No entity, ever: independent operators run their own nodes; a public directory and ledger, nothing more",
      },
      {
        key: "members_association",
        label: "A members' association (one member, one vote) holding keys behind recallable operator badges",
      },
      { key: "dao", label: "The Radix DAO, once it can receive assets" },
      { key: "start_with_none", label: "Start with no entity and create one only when there is something to hold" },
    ],
  },
  q6: {
    id: "q6",
    heading: "6. The Gateway after December",
    isMainHeading: true,
    body: ["The read side that wallets and apps use is funded through December 2026. After that:"],
    options: [
      { key: "become_customer", label: "The community should become the current operation's customer" },
      { key: "second_gateway", label: "The community should run a second Gateway in parallel" },
      { key: "wait_and_see", label: "Wait and see" },
    ],
  },
  q7: {
    id: "q7",
    heading: "7. Membership shape",
    isMainHeading: true,
    body: [
      "If there are members: is a tiered membership acceptable where a larger payment buys more hosting or sponsors seats for others, but never buys extra votes?",
    ],
    options: [
      { key: "yes", label: "Yes" },
      { key: "flat_fee", label: "No, one flat fee" },
      { key: "no_members", label: "No members at all; per-task funding only" },
    ],
  },
}

/** The "3. Are there willing participants?" group heading + intro, which
 *  wraps q3a/q3b/q3c — kept separate from TEMP_CHECKS because it is not
 *  itself a check, just the shared framing three of them sit under. */
export const Q3_GROUP = {
  heading: "3. Are there willing participants?",
  intro: "Everything else depends on this.",
}

export const PAGE_HEADER = {
  title: "Who keeps the lights on?",
  tagline:
    "An open set of questions to the Radix community. Nothing on this page is decided. Everything can change.",
  byline:
    "AI-drafted: this text was produced with AI research tooling and checked against public sources by bigdev, one pseudonymous builder who kept shipping through the halt. bigdev will replace it with his own words. Corrections welcome. Last updated 2026-09-17.",
}

export const WHERE_THINGS_STAND = {
  heading: "Where things stand",
  facts: [
    "Radix mainnet was halted from 31 August 2026 to 11 September 2026. Public reporting attributed the halt to an exploit in the engine's vault-authorisation logic that drained about $1.25M of bridged assets, by DefiLlama's count. The fix merged on 7 September and shipped in node release v1.4.0.0 on 10 September. The network's largest DeFi ecosystem announced in August that it is leaving, and XRD set its all-time low on 7 September, during the halt. This page exists because of that, not in spite of it.",
    "The Radix Foundation moved to maintenance mode in April 2026. As we understand it from the Foundation's April update, the Gateway, Connect Relay and Signalling services are pre-funded through December 2026 under a separate operation run by former Foundation staff. We have not confirmed the details of that arrangement or what follows it. If you know, tell us.",
    "The validator subsidy ended in June 2026. Market-making support was pre-funded through September 2026.",
    "The public node repository shipped v1.4.0.0 on 10 September 2026 after three months without a release; engine work continues in the Scrypto/engine repository. We have not checked the Gateway repository since the restart.",
    "The software licence (Radix License v1.0) permits anyone to run, modify, fork and redistribute the node and Gateway for any purpose.",
    "At our check on 13 September 2026, 100 validators held 4.61 billion XRD of active stake; 24 of them held two thirds of it and 79 held 99%.",
  ],
  closing:
    "We do not speak for the Foundation, RDX Works, the DAO, or any validator. We are asking because we do not know the answers.",
}

export const QUESTIONS_INTRO = {
  heading: "The questions",
  body: 'Each question is a temperature check. "It depends" and "not like that" are valid answers; the best ones come with a reason.',
  beforeMoneyLabel: "Before the money questions:",
  beforeMoneyBody:
    "if you spend anything on hosting or dues because of this page, expect that you may never get it back in any form. There is no return, refund, dividend or payout attached to anything here.",
}

export interface TableSpec {
  heading: string
  columns: string[]
  rows: string[][]
}

export const WHAT_WE_MEASURED = {
  heading: "What we measured",
  intro:
    "Estimates as of September 2026, using renewal prices from provider price pages and 2025–26 salary surveys, conservative on purpose. Corrections expected.",
  hosting: {
    heading:
      "Hosting, spread across independent providers (no provider above about 20% of seats; each validator has a hot standby)",
    columns: ["Fleet", "Validators", "Providers / countries", "Read side", "Low estimate, per year", "Conservative estimate, per year"],
    rows: [
      ["Minimal", "5 + 5 standbys", "5 / 5", "one Gateway database and API", "about $9K", "about $15K"],
      ["Standard", "16 + 16", "8 / 5+", "database with a replica, two APIs", "about $38K", "about $56K"],
      ["Full", "25 + 25", "10 / 8+", "blue-green production Gateway", "about $73K", "about $116K"],
    ],
  } satisfies TableSpec,
  hostingFootnote: "Hosting is not where the money goes. People are.",
  people: {
    heading: "The people (market rates; on-costs included where employed)",
    columns: ["Team", "What it could do", "What it could not do", "Low, per year", "Conservative, per year"],
    rows: [
      [
        "Half a person plus an on-call rota",
        "Triage, dependency patches, docs",
        "Promise a release cadence, a patch deadline, or a security review",
        "about $54K",
        "about $94K",
      ],
      [
        "Two engineers plus part-time security",
        "Node releases, Gateway migrations, a patch deadline",
        "Redundancy; the successor design as a deliverable",
        "about $236K",
        "about $342K",
      ],
      [
        "Five people including full-time security",
        "The above, with no single point of failure",
        "Set the protocol roadmap; guarantee a cadence for updates that originate upstream; match the core team's own first-incident turnaround",
        "about $480K",
        "about $580K",
      ],
    ],
  } satisfies TableSpec,
  membership: {
    heading: "What membership would cover, for scale only",
    intro:
      "This uses a round $1,000 a year per member for scale. Whether membership is flat, tiered (question 7), or does not exist at all is an open question above. We are not confident in these member counts.",
    columns: ["Members", "Roughly covers", "What that would mean"],
    rows: [
      ["20", "the minimal fleet", "lights on; no paid people"],
      ["about 110", "the minimal fleet and half a maintainer", "triage only"],
      [
        "about 400",
        "the standard fleet and two engineers",
        "a team that can promise releases; below roughly 400 the conservative numbers do not clear",
      ],
      [
        "1,000",
        "the full fleet and a five-person core",
        "the full model, if it ever gets there; it would need many non-developer supporters, not just builders",
      ],
    ],
  },
  membershipClosing:
    "Tiers change these counts: twenty Business members at $1,200 do the work of twenty-four at $1,000, and sponsors more. We do not know how many members exist. Our rough count of GitHub accounts that touched Scrypto code this year is somewhere between ten and fifty, and that is a floor that likely overcounts, since most are single old commits, forks or tutorials. Nobody has measured this well. Part of the point of this page is to find out.",
}

export const WHAT_WE_DO_NOT_KNOW = {
  heading: "What we do not know",
  items: [
    "Whether at least five independent operators would list and stay reliable on their own money.",
    "Who, by name, would run the Gateway after December, and on what terms.",
    "Whether crowdfunded task rounds can pay for real maintenance. A single security fix is ten to twenty engineer-days; XRD trades a few thousand dollars a day.",
    "How many of the listed validators are still running through the halt.",
    "Whether and when the DAO framework is ratified.",
    "Whether any of this matters if usage does not return. The two comparable cases we could find, Terra Classic and Ethereum Classic, kept running for years after the organisations around them moved on, and both did it by paying for core development: a funded nonprofit in one case, the community treasury in the other. Neither token has returned to its earlier highs. That is not proof it cannot happen here, but it is the only evidence we have.",
  ],
}

export const WHAT_THIS_IS_NOT = {
  heading: "What this is not",
  items: [
    "Not a fund, not custody, not a token, and nothing to buy. If you delegate, your XRD stays in your wallet.",
    "XRD pays no dividend. The 2018 token sale terms gave holders no right to dividends, profits or distributions. Nothing here is a claim on future income.",
    "We are not raising money, taking payment, or selling anything alongside this page.",
    "For this shared-infrastructure effort, licensing is not decided and nothing is published yet; the Guild's own code is public under Apache-2.0. The Radix node and Gateway software carries its own licence, described above, which already lets anyone run, modify and fork it.",
  ],
}

export const HOW_TO_ANSWER = {
  heading: "How to answer",
  body: "Vote on this page (web temperature check: unweighted, one vote per browser, not binding). Temperature checks will also run on the guild's Telegram; longer answers belong there or on RadixTalk. Disagreement is the useful part.",
}

export const WIDGET_COPY =
  "Web temperature check: unweighted, one vote per browser; votes from signed-in accounts are counted separately. Not binding."
