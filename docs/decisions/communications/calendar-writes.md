# Calendar writes

_Part of [Communications](../communications.md). See `docs/decisions/README.md` for the index._

### Tex edits any part of an event (2026-10-23)

The owner, 2026-10-23, after Tex added commute blocks but told them to put a
party's address on the party "yourself, since I can't edit an existing
event's location": "why can't tex edit calendar items ... plug in every
freaking gap". `calendar_event` now has `edit` and `rsvp` beside create,
move and cancel:

- `edit` finds the event as move does (title and start as they are now) and
  changes any of `new_title`, `new_start` + `new_end`, `location`, `notes`
  (`""` takes either off), `add_guests`, `remove_guests`, `meet`, `reminders`
  and `recurrence`. A repeating event is found as the one time it happens;
  `all_events: true` (and any change to how it repeats) reaches the series,
  whose start moves by as much as that one time's did. `recurrence: []`
  stops the series after this time.
- `rsvp` answers an invite (`accepted`, `declined`, `tentative`), changing
  only the person's own answer. It always tells the organizer, so it is held
  for one 👍, named.
- `create` also takes `reminders` and `recurrence`.

The approval rule is unchanged: an edit tells nobody unless the event has
guests, or the edit adds or removes some, and then it is put to the person
with them named. A reminder is the person's own and never asks. The control
plane refuses the shared parts of an invite somebody else organizes
(`not_organizer`, before any request, since Google would refuse it), and the
gateway then has Tex add the person's own event with the details instead of
handing the change back. The event is looked for on each connected calendar
that may be changed, not only the first, and a title written a little
differently still finds the one event at that moment that shares a word with
it. Tests: `apps/convex/__tests__/calendarEdit.test.ts`,
`apps/mcp/test/calendarGate.test.mjs` ("an existing event of their own gets
its address at once").

### Tex changes the person's own calendar without asking (2026-10-22)

Decided by the owner on 2026-10-22: "as long as there isn't a second person
added in a calendar event, there is no need to get permission, you can just
go ahead and do it, we only need confirmation when you are sending things to
another human being ... a personal calendar thing can be changed without a go
ahead unless the person asks for a go ahead". Every event `calendar_event`
touches is the person's alone (below: never an event with guests), so a
texted turn's change runs at once (`calendarGate.js`), after the same check
of the change and its limits. Another connected AI's change still waits for
their yes in the app, as the section below describes. An offer of a change
in Tex's own words is turned into the change itself, not into an ask
(`claimCheck.js`, `offerNotice`). Reversing this brings back the double ask
of 2026-10-22 ("Say yes and I'll add it", "yes", then "Give it a 👍"); the
test that fails is `calendarGate.test.mjs`, "a texted change to their own
calendar is made at once".

An invite to another person is a message to them and would wait for a yes,
as an email does; it is not built.

### A change that tells a guest waits for one 👍 (2026-10-22)

The owner, the same evening, after Tex refused to move a meeting with one
guest and told them to move it themselves: "it should've suggested the
change and had me 👍 to approve it". A move or a cancel of an event with
guests is no longer refused. The control plane's check of a move or a cancel
finds the event and names its guests (nothing spent, nothing changed); with
none, Tex's change runs at once as above. With any, the gate holds it as one
ask that shows the change and "Google will let <guests> know.", and the
person's yes or 👍 makes it with `notify_guests`, which is the only way the
control plane changes an event with guests, and then with
`sendUpdates=all`. A change without it to an event with guests is still
refused (`has_guests`). Tests: `calendarGate.test.mjs`, "a move that would
tell a guest is put to the person…", and in Convex "a move the person said
yes to with its guests named goes".

### Before 2026-10-22: no calendar change without the person's yes to that exact change

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
`calendar.events`; 20 changes an hour and 100 a day (5 and 20 until the owner raised them, 2026-10-22), all or none, spent only
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

### Asked of everyone who connects Calendar

Decided by the owner on 2026-10-23, reversing the testers-only rule of
2026-10-17. A texter with Calendar connected asked Tex to book a meeting, and
Tex said Calendar wasn't connected and sent a link: only staff had been asked
for `calendar.events`, so her connection could read and not write, and
reconnecting changed nothing. The owner: "??? what happened here", then "Yes,
everyone" for email, drafts and Chat as well. Our OAuth client is not yet
verified, so every consent screen already shows Google's unverified-app
warning for Gmail's restricted read; the write scopes add no screen anybody
would not see. Every connect now asks for the write scopes of the products it
connects (`WRITE_SCOPES` in `googleOAuth.ts`), and the tester check is gone.

A connection made before that grants read only. A change then refuses with
`calendar_read_only`, never `no_calendar`, and Tex sends the reconnect link
saying one reconnect lets it make the change, then makes it.

**Google is asked before anybody is told to reconnect** (2026-10-23, after
Tex told @blessing twice that her calendar could only be read while Settings
said "Connected"; the owner: "why wouldnt you actually check to see if you
have write access before sending this"). The stored scopes are what Google
granted at the last connect; when they say read-only, the control plane
refreshes each calendar connection's token and asks Google's tokeninfo what
the grant holds (`functions/googleScopeCheck.ts`). A stored list that was
behind is corrected and the change goes. A grant that truly can't change
events is refused with the accounts named, and Tex says once which account
needs the reconnect and to tick Select all. Settings marks a service the
grant can only read ("Calendar read only. Reconnect and tick Select all.")
with its Reconnect, instead of "Connected" (`lib/googleWriteAccess.ts`).
Reversing either fails `apps/convex/__tests__/calendarWrite.test.ts` or
`apps/mobile/__tests__/googleConnectionsCard.test.ts`.

### A new event can invite guests and get a Google Meet

`create` takes `guests` (1 to 10 addresses) and `meet: true` (decided by the
owner, 2026-10-23, the same booking). An invite reaches somebody, so it is held
like a move of an event with guests: the person reads the event with "Invite:"
and the addresses, and their 👍 or yes releases it with `notify_guests`, which
the control plane requires on any create with guests and Google then emails
(`sendUpdates=all`). A Meet is added with `conferenceDataVersion=1` and its
link is given back to say in the reply; a Meet alone tells nobody, so it runs
at once.

Tests: `apps/convex/__tests__/calendarWrite.test.ts`,
`apps/mcp/test/calendarGate.test.mjs`,
`apps/convex/__tests__/googleConnect/writeScopes.test.ts`.

## A create is safe to send twice (a review of a chat, 2026-10-24)

"Serving at church" landed on a person's calendar twice, and Tex deleted
one by hand in its browser. The gateway gave a calendar change the control
plane's default 8 seconds. A create that took longer (claiming the limit,
minting a Google token, Google's insert) still landed, but the model was told
"Nothing was changed; it can be asked for again" and sent it again. Now:

- A create asks Google for an event id worked out from the calendar, the
  title (any case or spacing), the start and end moments and any recurrence
  (`createdEventId` in `apps/convex/functions/lib/gatewayRoutes/calendarWrite.ts`).
  The same event asked for again is Google's 409, and the answer is the event
  already there (`existing`; the tool says "Already on … Nothing new was
  added"). An event the person deleted since keeps that id, cancelled, so it
  is added afresh without one. The id is a hash, so nothing of the event can
  be read from it.
- The gateway waits 30 seconds for a change (`CHANGE_TIMEOUT_MS`), as it
  waits for an email send.
- A call the gateway gave up on is told as "Not known whether it changed",
  never as failed (`NO_ANSWER` in `apps/mcp/src/tools/calendarWrite.js`).

The cost: asking for the very same event twice on purpose makes one, which is
what the person meant in every case we have seen. Undo: send creates without
`id`; `apps/convex/__tests__/calendarWrite.test.ts` "a create is safe to send
again" and `apps/mcp/test/calendarRetry.test.mjs` fail.
