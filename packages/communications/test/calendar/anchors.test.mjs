import { eventAnchor, eventCacheKey, isEventAnchor } from "../../src/calendar/anchors.js";

const EVENT_A = { account: "person@example.com", calendarId: "primary", eventId: "abc123" };
const EVENT_A_INSTANCE = { account: "person@example.com", calendarId: "primary", eventId: "abc123_20260907T140000Z" };
const EVENT_B = { account: "other@example.com", calendarId: "primary", eventId: "abc123" };

export function runCalendarAnchorChecks(check) {
  check("an anchor is evt- plus 16 hex characters", /^evt-[0-9a-f]{16}$/.test(eventAnchor(EVENT_A)));
  check("the same event hashes the same anchor twice", eventAnchor(EVENT_A) === eventAnchor({ ...EVENT_A }));
  check("a different account is a different anchor even with the same event id", eventAnchor(EVENT_A) !== eventAnchor(EVENT_B));
  check("a recurring instance's own id gets its own anchor, not its series'", eventAnchor(EVENT_A) !== eventAnchor(EVENT_A_INSTANCE));
  check(
    "an event with no id still gets an anchor rather than none",
    isEventAnchor(eventAnchor({ account: "a", calendarId: "b", eventId: undefined }))
  );

  check("isEventAnchor accepts what eventAnchor produces", isEventAnchor(eventAnchor(EVENT_A)));
  check("isEventAnchor refuses a message anchor's shape", !isEventAnchor("msg-0123456789abcdef"));
  check("isEventAnchor refuses the wrong length", !isEventAnchor("evt-0123"));
  check("isEventAnchor refuses non-hex", !isEventAnchor("evt-zzzzzzzzzzzzzzzz"));
  check("isEventAnchor refuses a non-string", !isEventAnchor(undefined) && !isEventAnchor(42));

  check(
    "a separator a caller can write cannot be forged into a collision",
    eventCacheKey({ account: "a b", calendarId: "c", eventId: "d" }) !== eventCacheKey({ account: "a", calendarId: "b c", eventId: "d" })
  );

  // -- sabotage record — measured, not assumed --------------------------
  //
  // Changed the NUL join in `anchorInput` back to a plain space (a real
  // regression this file's history already had once, caught only by cat -A
  // on a byte-level diff) — **1** check failed directly: the collision check
  // above, which is exactly the property a plain separator loses.
}
