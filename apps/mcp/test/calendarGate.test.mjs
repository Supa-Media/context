/**
 * THE CALENDAR GATE, END TO END: no change reaches the person's calendar
 * without their yes to that exact change, and the limits are asked about
 * before the person is (`src/tools/calendarGate.js`).
 *
 * Driven through the worker on the egress checks' world
 * (`agentEgressFixtures.mjs`), whose control-plane stub answers
 * `/gateway/calendar/event` as its flags say (`controlPlaneStub/calendar.mjs`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `calendar_event` left out of `HELD_GATES`. → `a texted calendar change
 *     is held, shown whole, and not made` fails: it is made at once.
 *  2. `calendar_event` left out of `YES_ONLY` in `textedApprovals.js`. → `an
 *     "ok" to a calendar change is not a yes` fails.
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

    model.install([{ toolCalls: [{ name: "send", args: { action: "calendar", args: CREATE } }] }, { text: "I'll add the dentist." }]);
    const asked = await ask(env, TOKEN_TEXTS, "put the dentist on my calendar tuesday 3 to 4");
    check(
      "a texted calendar change is held, shown whole, and not made",
      asked.status === 200 &&
        changes().length === 0 &&
        pending().length === 1 &&
        controlPlane.calendarCalls.length === 1 &&
        controlPlane.calendarCalls[0].check === true &&
        Array.isArray(asked.body?.verbatim) &&
        asked.body.verbatim[0] ===
          "Here's the change I'd make:\n\nAdd to your Google Calendar:\nDentist\nFrom 2026-10-20T15:00:00-04:00\nTo 2026-10-20T16:00:00-04:00\n\nLook good? Just say yes and I'll make the change.",
    );

    let before = model.requests.length;
    model.install([{ text: "OK." }]);
    await ask(env, TOKEN_TEXTS, "ok");
    model.install([{ text: "Yes what?" }]);
    await ask(env, TOKEN_TEXTS, "yes");
    check("an \"ok\" to a calendar change is not a yes", changes().length === 0 && model.requests.length > before);

    model.install([{ toolCalls: [{ name: "calendar_event", args: CREATE }] }, { text: "Here it is." }]);
    await ask(env, TOKEN_TEXTS, "add the dentist again please");
    before = model.requests.length;
    const yes = await ask(env, TOKEN_TEXTS, "YES");
    check(
      "a texted YES makes exactly that change, without a model",
      model.requests.length === before &&
        changes().length === 1 &&
        JSON.stringify(changes()[0].change) === JSON.stringify(readCalendarChange(CREATE).change) &&
        yes.body?.answer === 'Done: add "Dentist" to your calendar.',
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
    const bad = await call(env, TOKEN_MCP, "calendar_event", { ...CREATE, start: "tuesday 3pm" });
    check("a time with no offset is refused before anything", bad.isError === true && /start is a time with its offset/.test(textOf(bad)));
  } finally {
    world.restore();
  }
}
