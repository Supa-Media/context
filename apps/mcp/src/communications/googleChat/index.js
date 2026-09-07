// One import for whatever eventually schedules this sync — a Convex action,
// or a gateway endpoint it calls. Anything missing here is a consumer that
// has to reach into a sibling file instead.

export { ChatApiError, listMessagesPage, listSpacesPage } from "./client.js";
export {
  ASSUMED_MESSAGES_PER_ACTIVE_SPACE_PER_DAY,
  ASSUMED_RENDERED_BYTES_PER_MESSAGE,
  BACKFILL_WINDOW_DAYS,
  estimateChatBackfill,
  estimateChatBackfillWindows,
} from "./backfill.js";
export { CHAT_SCOPES, DAY_MS, DEFAULT_BACKFILL_DAYS, REGEN_LOOKBACK_DAYS, SPACE_STATES } from "./protocol.js";
export { dayNonce, syncGoogleChat } from "./sync.js";
export { chatMessageToEvent, chatSpaceType, fallbackSpaceLabel, isHistoryOn, spaceDisplayName } from "./transform.js";
