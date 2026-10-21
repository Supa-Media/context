# Calendar writes

_Part of [Communications](../communications.md). See `docs/decisions/README.md` for the index._

### No calendar change is made without the person's yes to that exact change

Decided by the owner on 2026-10-17: "weren't you supposed to … enable sending
emails and updating calendars? it should work for testing accounts before we
need it approved". An AI may add, move or cancel one event on the person's
own primary Google Calendar (`calendar_event`, v2 `send` action `calendar`),
held exactly as an email is ([sending-email](./sending-email.md)):

- The gate (`apps/mcp/src/tools/calendarGate.js`) runs before the
  deployment's egress switch, checks the change as the control plane will,
  and asks the limits without spending them, so the person is never asked to
  approve a change that would be refused.
- Tex or another connected AI may ask; a routine or a dream never may.
- The held record carries the whole change, texted verbatim, its times in
  words read off the offset given ("Wednesday, October 21, 7 to 8 pm"; the
  owner, 2026-10-21). An offer of a change is held when Tex makes it, so the
  first yes is to the exact change
  ([honest answers](../texting-assistant/honest-answers.md)). Only a literal
  YES releases it, one change per text; "ok" disarms it. Another AI's change
  is approved in the app.

The control plane (`/gateway/calendar/event`) decides what the gateway is not
trusted with alone: the calendar is the token's person's own, from their
personal workspace only, on a connection whose consent granted
`calendar.events`; 5 changes an hour and 20 a day, all or none, spent only
once the event is found.

### A move or a cancel names the event by its title and start, and must match one

Event ids are not in the person's calendar notes, so the model names the
event as it sees it: its exact title and its current start. The route lists
that day either side and needs exactly one event with that title (ignoring
case) starting at that moment. None is `not_found`, two are `ambiguous`, and
neither changes anything. Times always carry their offset or are whole days:
nothing is guessed about a time zone.

### Never an event with guests

A change to an event with other attendees emails them, which would be sending
mail by another door without the email gate. So an event with any attendee
other than the person is refused (`has_guests`), new events take no
attendees, and every request asks Google for `sendUpdates=none` besides.
Inviting people is a follow-up that has to come through the email gate's
reasoning first.

### Testers only until Google's review

`calendar.events` is a sensitive scope. Until our OAuth client is verified for
it, Context asks for it only of testers: verified staff addresses
(`ADMIN_EMAILS`) and the production test account (`isGoogleWriteTester`,
`TESTER_WRITE_SCOPES` in `googleOAuth.ts`). A tester reconnects Google once to
grant it. Everyone else's change refuses with `no_calendar` and the AI tells
them what to change instead.

Tests: `apps/convex/__tests__/calendarWrite.test.ts`,
`apps/mcp/test/calendarGate.test.mjs`,
`apps/convex/__tests__/googleConnect/writeScopes.test.ts`.
