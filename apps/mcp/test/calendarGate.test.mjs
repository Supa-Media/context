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
 *  3. `claimCheck.js` never giving `OFFER_NOTICE` (2026-10-21). → `an offer of
 *     a calendar change is held as it is made…` and `the first yes to that
 *     offer makes the change` fail.
 *  4. `answerWithAsk` without `withoutWaitTalk`. → `an offer of a calendar
 *     change is held as it is made…` fails.
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
          `Here's the change I'd make:\n\nAdd to your Google Calendar:\nDentist\nTuesday, October 20${new Date().getUTCFullYear() === 2026 ? "" : ", 2026"}, 3 to 4 pm\n\nGive it a 👍 and I'll make the change.`,
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
        yes.body?.answer === 'Done, I added "Dentist" to your calendar.',
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
    // The owner's chat, 2026-10-21: an offer in words, a "yes", a second ask, a second "YES".
    const DINNER = { action: "create", title: "Emmanuela/Sayo", start: "2026-10-21T19:00:00-04:00", end: "2026-10-21T20:00:00-04:00" };
    model.install([
      { text: "Want me to add 'Emmanuela/Sayo,' 7 to 8 pm today?" },
      { toolCalls: [{ name: "calendar_event", args: DINNER }] },
      { text: "Still waiting on the calendar yes. Check your messages from Context for the confirmation and tap it." },
    ]);
    const offered = await ask(env, TOKEN_TEXTS, "I'm seeing Emmanuela and Sayo at 7 tonight");
    const offerAnswer = String(offered.body?.answer ?? "");
    check(
      "an offer of a calendar change is held as it is made, its times in words, with no talk of waiting elsewhere",
      pending().length > 0 &&
        offerAnswer.includes("Wednesday, October 21") &&
        offerAnswer.includes("7 to 8 pm") &&
        !/messages from Context|still waiting|T19:00/i.test(offerAnswer),
    );
    before = model.requests.length;
    const made = changes().length;
    const first = await ask(env, TOKEN_TEXTS, "yes");
    check(
      "the first yes to that offer makes the change",
      model.requests.length === before && changes().length === made + 1 && first.body?.answer === 'Done, I added "Emmanuela/Sayo" to your calendar.',
    );

    const bad = await call(env, TOKEN_MCP, "calendar_event", { ...CREATE, start: "tuesday 3pm" });
    check("a time with no offset is refused before anything", bad.isError === true && /start is a time with its offset/.test(textOf(bad)));
  } finally {
    world.restore();
  }
}
