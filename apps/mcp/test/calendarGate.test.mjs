/**
 * THE CALENDAR GATE, END TO END (`src/tools/calendarGate.js`): Tex changes
 * the person's own calendar at once (the owner, 2026-10-22), another AI's
 * change waits for their yes in the app, and the limits are asked about
 * first either way.
 *
 * Driven through the worker on the egress checks' world
 * (`agentEgressFixtures.mjs`), whose control-plane stub answers
 * `/gateway/calendar/event` as its flags say (`controlPlaneStub/calendar.mjs`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `calendar_event` left out of `HELD_GATES`. → `a routine never changes
 *     the calendar; another AI's change waits for the app` fails.
 *  2. `calendarGate` holding a texted change as before 2026-10-22. → `a
 *     texted change to their own calendar is made at once…` and `the first
 *     text makes the change…` fail.
 *  3. `calendarGate` letting a texted change through whatever its guests. →
 *     `a move that would tell a guest is put to the person…` fails.
 *  4. `calendarGate` checking a create's invitees without `notify_guests`. →
 *     `a booking that invites somebody is put to the person…` fails (the
 *     check is refused invalid).
 *  5. `readCalendarChange` without `edit`, as before 2026-10-23. → `an
 *     existing event of their own gets its address at once…` fails.
 */

import { ask, call, textOf, createEgressWorld, TOKEN_MCP, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { readCalendarChange } from "../src/tools/calendarWrite.js";

const CREATE = { action: "create", title: "Dentist", start: "2026-10-20T15:00:00-04:00", end: "2026-10-20T16:00:00-04:00" };

export async function runCalendarGateChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const changes = () => controlPlane.calendarCalls.filter((entry) => !entry.check);

  try {
    controlPlane.flags.calendarAddress = "seyi@gmail.example";

    // The owner, 2026-10-22: a change to their own calendar needs no go-ahead.
    model.install([{ toolCalls: [{ name: "send", args: { action: "calendar", args: CREATE } }] }, { text: "Done, the dentist is on your calendar." }]);
    const asked = await ask(env, TOKEN_TEXTS, "put the dentist on my calendar tuesday 3 to 4");
    check(
      "a texted change to their own calendar is made at once, checked first, with nothing to approve",
      asked.status === 200 &&
        changes().length === 1 &&
        JSON.stringify(changes()[0].change) === JSON.stringify(readCalendarChange(CREATE).change) &&
        pending().length === 0 &&
        controlPlane.calendarCalls[0].check === true &&
        asked.body?.answer === "Done, the dentist is on your calendar." &&
        !(asked.body?.verbatim ?? []).some((text) => text.includes("👍")),
    );

    controlPlane.flags.calendarAddress = null;
    model.install([{ toolCalls: [{ name: "calendar_event", args: { ...CREATE, title: "Gym" } }] }, { text: "Add it yourself." }]);
    const pendingBefore = pending().length;
    await ask(env, TOKEN_TEXTS, "add gym");
    check(
      "with no calendar that may be changed, nothing is put to the person",
      pending().length === pendingBefore && JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("no Google Calendar connected"),
    );
    controlPlane.flags.calendarAddress = "seyi@gmail.example";

    const routine = await call(env, TOKEN_ROUTINE, "calendar_event", CREATE);
    const mcp = await call(env, TOKEN_MCP, "calendar_event", { ...CREATE, title: "Lunch" });
    check(
      "a routine never changes the calendar; another AI's change waits for the app",
      routine.isError === true &&
        /may not change/.test(textOf(routine)) &&
        mcp.isError === true &&
        /approve this exact change in the Context app/.test(textOf(mcp)) &&
        changes().length === 1,
    );
    // The owner's chat, 2026-10-22 5:04 PM: "Say yes and I'll add it", a "yes", then a second ask for a 👍. Now there is no ask at all.
    const MARI = { action: "create", title: "MARI LOLA event", start: "2026-11-01T15:00:00-05:00", end: "2026-11-01T17:00:00-05:00", location: "Bethesda" };
    model.install([{ toolCalls: [{ name: "calendar_event", args: MARI }] }, { text: "Done, Mari Lola is on your calendar for Sunday, November 1, 3 to 5 pm." }]);
    const made = changes().length;
    const waiting = pending().length;
    const mari = await ask(env, TOKEN_TEXTS, "On my calendar put mari lola event in bethesda for 3-5pm next sunday");
    check(
      "the first text makes the change, with no yes asked for",
      changes().length === made + 1 && pending().length === waiting && !/👍|say yes/i.test(String(mari.body?.answer ?? "")),
    );

    // The owner's chat, 2026-10-22 6:10 PM: "move my meeting with Sayo today to 9" was refused for its guest, and they were told to do it themselves.
    const MOVE = { action: "move", title: "Sayo / Seyi", start: "2026-10-22T19:00:00-04:00", new_start: "2026-10-22T21:00:00-04:00", new_end: "2026-10-22T22:00:00-04:00" };
    controlPlane.flags.calendarGuests = ["Blessing Aodu"];
    model.install([{ toolCalls: [{ name: "calendar_event", args: MOVE }] }, { text: "I'd move it to 9 and let Blessing know." }]);
    const beforeGuest = changes().length;
    const proposed = await ask(env, TOKEN_TEXTS, "can you move my meeting with Sayo today to 9");
    const shown = (proposed.body?.verbatim ?? []).join("\n");
    check(
      "a move that would tell a guest is put to the person with the guest named, not made and not refused",
      changes().length === beforeGuest &&
        shown.includes("Move on your Google Calendar:") &&
        shown.includes("Google will let Blessing Aodu know.") &&
        shown.includes("👍") &&
        !/yourself/i.test(String(proposed.body?.answer ?? "")),
    );
    const yes = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "their yes makes it, and Google tells the guest",
      yes.status === 200 && changes().length === beforeGuest + 1 && changes().at(-1).change.notify_guests === true && changes().at(-1).answer.ok === true,
    );
    controlPlane.flags.calendarGuests = [];
    const sneaky = await ask(env, TOKEN_TEXTS, "x").then(() => call(env, TOKEN_MCP, "calendar_event", { ...MOVE, notify_guests: true }));
    check("another AI passing notify_guests itself still waits for the app", sneaky.isError === true && /Context app/.test(textOf(sneaky)) && changes().length === beforeGuest + 1);

    // The owner's chat, 2026-10-23: "Still open: add 150 McGuinness Blvd Apt 2, Brooklyn to Lau's party event yourself, since I can't edit an existing event's location."
    const ADDRESS = { action: "edit", title: "Lau's Birthday", start: "2026-10-24T19:00:00-04:00", location: "150 McGuinness Blvd Apt 2, Brooklyn" };
    model.install([{ toolCalls: [{ name: "send", args: { action: "calendar", args: ADDRESS } }] }, { text: "Done, Lau's party has the address." }]);
    const beforeEdit = changes().length;
    const waitingEdit = pending().length;
    const edited = await ask(env, TOKEN_TEXTS, "make sure the calendar items have the actual addresses");
    check(
      "an existing event of their own gets its address at once, with nothing to approve",
      changes().length === beforeEdit + 1 &&
        JSON.stringify(changes().at(-1).change) === JSON.stringify(ADDRESS) &&
        pending().length === waitingEdit &&
        !/yourself|can't edit/i.test(String(edited.body?.answer ?? "")),
    );

    controlPlane.flags.calendarGuests = ["Lau"];
    const RSVP = { action: "rsvp", title: "Lau's Birthday", start: "2026-10-24T19:00:00-04:00", response: "accepted" };
    model.install([{ toolCalls: [{ name: "calendar_event", args: RSVP }] }, { text: "I'd tell Lau you're going." }]);
    const beforeRsvp = changes().length;
    const rsvped = await ask(env, TOKEN_TEXTS, "rsvp yes to lau's party");
    const rsvpShown = (rsvped.body?.verbatim ?? []).join("\n");
    check(
      "an RSVP tells the organizer, so it is put to the person for one 👍 first",
      changes().length === beforeRsvp && rsvpShown.includes("Reply to the invite") && rsvpShown.includes("Answer: Going") && rsvpShown.includes("Google will let Lau know."),
    );
    await ask(env, TOKEN_TEXTS, "\u{1F44D}");
    check("their 👍 sends the answer", changes().length === beforeRsvp + 1 && changes().at(-1).change.notify_guests === true);
    controlPlane.flags.calendarGuests = [];

    controlPlane.flags.calendarRefusal = "not_organizer";
    model.install([{ toolCalls: [{ name: "calendar_event", args: { ...ADDRESS, location: "Elsewhere" } }] }, { text: "Added your own copy with the address." }]);
    await ask(env, TOKEN_TEXTS, "put the address on lau's party");
    check(
      "an invite somebody else organizes has Tex add the person's own event with the details, never hand it back",
      /create their own event/.test(JSON.stringify(model.requests.at(-1)?.messages ?? [])) &&
        /Never tell the person to change it themselves/.test(JSON.stringify(model.requests.at(-1)?.messages ?? [])),
    );
    controlPlane.flags.calendarRefusal = null;

    // Blessing's text, 2026-10-23: book "Sayo / Seyi" Thursday 6:30 to 7, with a Google Meet, and invite Seyi.
    const BOOK = {
      action: "create",
      title: "Sayo / Seyi",
      start: "2026-10-29T18:30:00-04:00",
      end: "2026-10-29T19:00:00-04:00",
      guests: ["seyi@example.invalid"],
      meet: true,
    };
    model.install([{ toolCalls: [{ name: "calendar_event", args: BOOK }] }, { text: "I'd book it with a Meet and invite Seyi." }]);
    const beforeBook = changes().length;
    const booking = await ask(env, TOKEN_TEXTS, "book sayo / seyi thursday 6:30-7 with a google meet and invite seyi");
    const read = (booking.body?.verbatim ?? []).join("\n");
    check(
      "a booking that invites somebody is put to the person with the invitee and the Meet named",
      changes().length === beforeBook &&
        read.includes("Add to your Google Calendar:") &&
        read.includes("Invite: seyi@example.invalid") &&
        read.includes("With a Google Meet link") &&
        read.includes("👍"),
    );
    model.install([{ text: "Booked, Meet link https://meet.google.com/abc-defg-hij" }]);
    const thumbs = await ask(env, TOKEN_TEXTS, "\u{1F44D}");
    check(
      "one 👍 books it, invites Seyi and gets the Meet link",
      thumbs.status === 200 &&
        changes().length === beforeBook + 1 &&
        changes().at(-1).change.notify_guests === true &&
        changes().at(-1).change.guests?.[0] === "seyi@example.invalid" &&
        changes().at(-1).answer.meet === "https://meet.google.com/abc-defg-hij",
    );
    const solo = await call(env, TOKEN_MCP, "calendar_event", { ...CREATE, notify_guests: true });
    check("notify_guests on a create with nobody invited is refused", solo.isError === true && /notify_guests/.test(textOf(solo)));

    controlPlane.flags.calendarRefusal = "calendar_read_only";
    model.install([{ toolCalls: [{ name: "calendar_event", args: { ...CREATE, title: "Run" } }] }, { text: "One reconnect and I'll add it." }]);
    await ask(env, TOKEN_TEXTS, "add run");
    check(
      "a calendar connected before write access asks for one reconnect, and never says it isn't connected",
      JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("Never say it isn't connected"),
    );
    // @blessing, 2026-10-23: two accounts, and Tex never said which one needed it.
    check(
      "it names the account Google said can only be read, and says it once",
      JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("The account to reconnect: sayo@example.invalid.") &&
        JSON.stringify(model.requests.at(-1)?.messages ?? []).includes("Say it once"),
    );
    controlPlane.flags.calendarRefusal = null;

    const bad = await call(env, TOKEN_MCP, "calendar_event", { ...CREATE, start: "tuesday 3pm" });
    check("a time with no offset is refused before anything", bad.isError === true && /start is a time with its offset/.test(textOf(bad)));
  } finally {
    world.restore();
  }
}
