# Calendar writes

_Part of [Communications](../communications.md). See `docs/decisions/README.md` for the index._

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
