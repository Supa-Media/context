/**
 * A CALENDAR CREATE IS SAFE TO SEND AGAIN, AND A SLOW ONE IS NEVER TOLD AS
 * FAILED (a review of a chat, 2026-10-24: "Serving at church" landed twice
 * and one was deleted by hand through the browser).
 *
 * The control plane makes a create under an id worked out from the event
 * (`apps/convex/functions/lib/gatewayRoutes/calendarWrite.ts`, tested in
 * `apps/convex/__tests__/calendarWrite.test.ts`); here, the gateway waits for
 * its answer, passes on that it was already there, and says a call it gave
 * up on may have been made.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `changePersonCalendar` posting without `timeoutMs` → "a change waits for
 *     Google" fails.
 *   `toolCalendarEvent`'s catch answering `REFUSED.unavailable` → "a change
 *     with no answer in time is never told as failed" fails.
 *   `refusalFor` ignoring `google` → "a refusal says what Google said" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CHANGE_TIMEOUT_MS, createCalendarMethods } from "../src/controlPlane/calendar.js";
import { NO_ANSWER, toolCalendarEvent } from "../src/tools/calendarWrite.js";

const CREATE = { action: "create", title: "Serving at church", start: "2026-10-25T07:30:00-04:00", end: "2026-10-25T14:30:00-04:00" };
const textOf = (result) => result?.content?.map((part) => part.text).join("\n") ?? "";

test("a change waits for Google, and a create that was already there says so", async () => {
  const asked = [];
  const methods = createCalendarMethods({
    async post(path, body, options) {
      asked.push(options?.timeoutMs);
      return { ok: true, calendar: "seyi@gmail.example", existing: true };
    },
  });
  const answer = await methods.changePersonCalendar("token", "ws", CREATE);
  assert.deepEqual(asked, [CHANGE_TIMEOUT_MS]);
  assert.ok(CHANGE_TIMEOUT_MS >= 30_000);
  assert.equal(answer.existing, true);
  const told = textOf(await toolCalendarEvent({ calendar: { change: async () => answer } }, CREATE));
  assert.match(told, /^Already on seyi@gmail\.example's calendar/);
  assert.match(told, /one, not two/);
  const made = textOf(await toolCalendarEvent({ calendar: { change: async () => ({ ok: true, calendar: "seyi@gmail.example" }) } }, CREATE));
  assert.match(made, /^Done on seyi@gmail\.example's calendar/);
});

test("a change with no answer in time is never told as failed", async () => {
  const result = await toolCalendarEvent(
    {
      calendar: {
        change: async () => {
          throw new Error("timed out");
        },
      },
    },
    CREATE,
  );
  assert.equal(result.isError, true);
  assert.equal(textOf(result), NO_ANSWER);
  assert.match(NO_ANSWER, /may have been made/);
  assert.doesNotMatch(NO_ANSWER, /Nothing was changed/);
});

test("a refusal says what Google said, and never invites a promise to keep trying (@shyoh, 2026-10-25)", async () => {
  const methods = createCalendarMethods({
    async post() {
      return { ok: false, refused: "unavailable", google: { status: 400, reason: "invalid", message: "Invalid resource id value.\u202e" } };
    },
  });
  const answer = await methods.changePersonCalendar("token", "ws", CREATE);
  assert.deepEqual(answer, { ok: false, refused: "unavailable", google: { status: 400, reason: "invalid", message: "Invalid resource id value." } });
  const told = textOf(await toolCalendarEvent({ calendar: { change: async () => answer } }, CREATE));
  assert.match(told, /Google said \(HTTP 400, invalid\): Invalid resource id value\./);
  assert.match(told, /never promise to keep trying/);
  assert.match(told, /never say you tried again unless you called it/);
  // Nothing passed off as Google's words that isn't a status.
  const odd = await createCalendarMethods({ post: async () => ({ ok: false, refused: "unavailable", google: { status: "x", message: "hi" } }) }).changePersonCalendar("t", "w", CREATE);
  assert.deepEqual(odd, { ok: false, refused: "unavailable" });
});
