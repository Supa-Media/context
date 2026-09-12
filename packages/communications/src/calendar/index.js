// One import for the gateway's calendar sync and for anything else that has
// to agree with what a day of somebody's calendar becomes on disk.

export * from "./protocol.js";
export {
  addCalendarDays,
  dateRange,
  isValidTimeZone,
  normalizeTimeZone,
  occursOn,
  zoneAbbreviation,
  zonedClock,
  zonedDateKey,
  zonedDayStartInstant,
} from "./timezone.js";
export {
  calendarDayNotePath,
  isCalendarDayDate,
  isCalendarDayNotePath,
  parseCalendarDayPath,
} from "./paths.js";
export { eventAnchor, eventCacheKey, isEventAnchor } from "./anchors.js";
export { CALENDAR_FENCE_MARKER, NO_TITLE, defangCalendarFence, renderCalendarDay } from "./render.js";
export {
  applyIncremental,
  horizonDates,
  mergeEventCaches,
  planSyncRequest,
  projectDay,
  pruneCacheToWindow,
  rebuildCache,
} from "./sync.js";
export {
  DEFAULT_MIN_TITLE_SCORE,
  DEFAULT_WINDOW_TOLERANCE_MS,
  attachEventLink,
  calendarEventLink,
  candidatesFromDay,
  matchMeetingToEvent,
  normalizeTitleWords,
  readEventLink,
  titleSimilarity,
  windowsOverlap,
} from "./meetingLink.js";
export { contactDraftsFromEvent } from "./contacts.js";
