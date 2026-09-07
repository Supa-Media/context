// One import for the gateway, for the control plane and for anything else that
// has to agree with what a communication becomes on disk. Anything missing
// here is a consumer that has to reach into a file path instead.

export * from "./protocol.js";
export {
  MAX_SLUG_LENGTH,
  SLUG_FALLBACK,
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
export { fnv1a64, isMessageAnchor, messageAnchor, threadKey } from "./anchors.js";
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
  groupIntoThreads,
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
  identifierSet,
  mergeContacts,
  normalizeIdentifier,
  parseContactNote,
  renderContactNote,
  suggestMerge,
} from "./contacts.js";
