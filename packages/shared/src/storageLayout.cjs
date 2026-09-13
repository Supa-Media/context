/** Context-owned on-bucket storage layout, shared by every producer. */
const CONTEXT_ROOT = ".context/";
const STORAGE_LAYOUT_VERSION = 1;
const STORAGE_LAYOUT_MANIFEST_KEY = `${CONTEXT_ROOT}manifest.json`;
const STORAGE_LAYOUT_MIGRATION_KEY = `${CONTEXT_ROOT}migrations/storage-layout-v1.json`;

const AUDIT_PREFIX = `${CONTEXT_ROOT}audit/`;
const HISTORY_PREFIX = `${CONTEXT_ROOT}history/`;
const IMAGE_PREFIX = `${CONTEXT_ROOT}assets/images/`;
const SEARCH_PREFIX = `${CONTEXT_ROOT}search/`;
const MEETING_PREFIX = `${CONTEXT_ROOT}meetings/sessions/`;
const NOTE_ACL_PREFIX = `${CONTEXT_ROOT}access/note-acl/`;
const GRANOLA_EVENTS_PREFIX = `${CONTEXT_ROOT}integrations/granola/events/`;
const PROPOSAL_PREFIX = `${CONTEXT_ROOT}proposals/`;
const PROBE_PREFIX = `${CONTEXT_ROOT}probes/`;

const LEGACY_STORAGE_PREFIXES = Object.freeze([
  [".audit/", AUDIT_PREFIX],
  [".history/", HISTORY_PREFIX],
  [".images/", IMAGE_PREFIX],
  [".index/", SEARCH_PREFIX],
  [".meetings/sessions/", MEETING_PREFIX],
  [".note-acl/", NOTE_ACL_PREFIX],
  [".granola-events/", GRANOLA_EVENTS_PREFIX],
  [".proposals/", PROPOSAL_PREFIX],
  [".context-probe/", PROBE_PREFIX],
]);

function currentStorageKey(key) {
  for (const [legacy, current] of LEGACY_STORAGE_PREFIXES) {
    if (key.startsWith(legacy)) return `${current}${key.slice(legacy.length)}`;
  }
  return key;
}

function legacyStorageKey(key) {
  for (const [legacy, current] of LEGACY_STORAGE_PREFIXES) {
    if (key.startsWith(current)) return `${legacy}${key.slice(current.length)}`;
  }
  return null;
}

module.exports = {
  CONTEXT_ROOT,
  STORAGE_LAYOUT_VERSION,
  STORAGE_LAYOUT_MANIFEST_KEY,
  STORAGE_LAYOUT_MIGRATION_KEY,
  AUDIT_PREFIX,
  HISTORY_PREFIX,
  IMAGE_PREFIX,
  SEARCH_PREFIX,
  MEETING_PREFIX,
  NOTE_ACL_PREFIX,
  GRANOLA_EVENTS_PREFIX,
  PROPOSAL_PREFIX,
  PROBE_PREFIX,
  LEGACY_STORAGE_PREFIXES,
  currentStorageKey,
  legacyStorageKey,
};
