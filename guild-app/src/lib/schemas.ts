// Badge schema configuration

import { MANAGER, BADGE_NFT, ADMIN_BADGE } from "./config";

export interface SchemaConfig {
  manager: string;
  badge: string;
  adminBadge: string;
  tiers: string[];
  freeMint: boolean;
}

export const SCHEMAS: Record<string, SchemaConfig> = {
  guild_member: {
    manager: MANAGER,
    badge: BADGE_NFT,
    adminBadge: ADMIN_BADGE,
    tiers: ["member", "contributor", "builder", "steward", "elder"],
    freeMint: true,
  },
  guild_role: {
    manager: "component_rdx1crh7qlan0yuwrf8wkq7vg7tkrc6w3ftr00qqf4auktqv2uuwwg8lut",
    badge: "resource_rdx1ntr6ye27zlyg2m06r90cletnwlzpedcv6yl0rhve64pp8prg0tw65e",
    // "Guild Role Badge Admin" (fungible, supply 1), NOT ADMIN_BADGE: this
    // manager's mint_badge allows [admin, _owner_], admin resolves to Owner,
    // and the owner rule is Require(this resource) with updater None, so it
    // cannot change (all read off the Gateway 2026-09-23). Was "", which made
    // /admin's "Mint Role Badge" throw before the wallet opened. That action
    // was then REMOVED (bigdev, 2026-09-23): this manager is retired, 0
    // minted ever, and each mint paid it a 1 XRD royalty. Nothing in the app
    // mints role badges now; the value is kept correct so a future caller
    // cannot inherit a blank.
    adminBadge: "resource_rdx1th2dhtapy7jegr4p6ff2xgvnnvlwamqhh23kqgyr7xu7wmalkvwmfw",
    tiers: ["admin", "moderator", "contributor"],
    freeMint: false,
  },
};
