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

    const bad = await call(env, TOKEN_MCP, "calendar_event", { ...CREATE, start: "tuesday 3pm" });
    check("a time with no offset is refused before anything", bad.isError === true && /start is a time with its offset/.test(textOf(bad)));
  } finally {
    world.restore();
  }
}
