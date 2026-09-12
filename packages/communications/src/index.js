// One import for the gateway, for the control plane and for anything else that
// has to agree with what a communication becomes on disk. Anything missing
// here is a consumer that has to reach into a file path instead.

export * from "./protocol.js";
export {
  MAX_SLUG_LENGTH,
  SLUG_FALLBACK,
  channelDestinationFolder,
  channelDayNotePath,
  channelFolder,
  chooseMailboxSlug,
  contactNotePath,
  contactSlug,
  isCalendarDate,
  isChannelDayNotePath,
  isContactNotePath,
  isMailboxSlug,
  normalizeRoot,
  parseChannelDayPath,
  slugifyAddress,
} from "./paths.js";
export { fnv1a64, isMessageAnchor, messageAnchor, spaceKey, threadKey } from "./anchors.js";
export {
  AVERAGE_MESSAGE_BYTES_HIGH,
  AVERAGE_MESSAGE_BYTES_LOW,
  estimateBackfillWindows,
  estimateMailboxBackfill,
} from "./estimate.js";
export {
  FENCE_MARKER,
  NO_SUBJECT,
  defangFence,
  defangLinks,
  defangOutsideFence,
  groupIntoSpaces,
  groupIntoThreads,
  parseChannelDayMessages,
  parseChannelDayNote,
  planChannelDay,
  renderChannelDayNote,
  singleLine,
  utf8Length,
} from "./note.js";
export {
  ACTIVITY_HEADING,
  IDENTIFIER_KINDS,
  NOTES_HEADING,
  activityLink,
  canAutoMerge,
  contactDraftsFromCommunication,
  contactPathForDraft,
  identifierSet,
  mergeContacts,
  mergeContactNote,
  normalizeIdentifier,
  parseContactNote,
  parseContactView,
  renderContactNote,
  suggestMerge,
} from "./contacts.js";
// Calendar lives in its own submodule (`./calendar/`) rather than flattened
// in here: it is a distinct kind of thing (an event, not a message) with its
// own folder, own frontmatter and own sync bookkeeping, and every name below
// is namespaced with `Calendar` or `calendar*` precisely so it can be
// re-exported here without colliding with the channel-day names above.
export * from "./calendar/index.js";
