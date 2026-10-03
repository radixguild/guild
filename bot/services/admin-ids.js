'use strict';
// Single source of truth for admin Telegram IDs. Reads ADMIN_TG_IDS env once
// at module load. Returns an empty array when unset — every consumer must
// fail closed rather than fall back to a hardcoded ID. (Pre-#80 the fallback
// was the bot author's TG id, hardcoded in three different files; that was
// a fail-open privilege bug if a deploy forgot the env.)

function parseAdminIds() {
  return (process.env.ADMIN_TG_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

const ADMIN_IDS = parseAdminIds();

function isAdmin(id) {
  if (!Number.isFinite(Number(id))) return false;
  return ADMIN_IDS.includes(Number(id));
}

// Primary admin: first id in ADMIN_TG_IDS, or null if unset. Use ONLY for
// non-privileged "default attribution" cases (e.g. creator id on a system-
// generated bounty). Never use as an authorization fallback.
function primaryAdmin() {
  return ADMIN_IDS.length > 0 ? ADMIN_IDS[0] : null;
}

module.exports = { ADMIN_IDS, isAdmin, primaryAdmin };
