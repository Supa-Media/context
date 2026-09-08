/**
 * The loop notices meetings, and does not notice flickers.
 *
 * The judgement is not tested here — it belongs to
 * `packages/meetings/src/detect.js` and has its own suite. What is tested here
 * is everything this app does *around* that judgement, and the three things
 * that would break a real recording:
 *
 *  1. **A transition is reported once, on the edge.** The panel is raised by
 *     `activated`; a loop that reported `activated` on every poll while a
 *     meeting was running would raise a panel every five seconds.
 *  2. **A flicker reaches neither edge.** One poll of Zoom does not start a
 *     recording; a two-poll network blip does not end one. The thresholds are
 *     the contract's, and the loop's job is to feed the reducer faithfully
 *     rather than to second-guess it.
 *  3. **A blocked app is invisible to the detector.** Not filtered afterwards —
 *     absent from the signals the detector is given, so a blocked app cannot
 *     become a source, a title, or a line in the evidence list.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole desktop suite.
 *
 *   `redactBlocked` dropped from `tick`                                     5
 *   `transition` computed from `state.active` alone, without `previous`     4
 *   the `inFlight` guard removed, with two overlapping ticks                1
 *   a collector failure allowed to propagate out of `collectSignals`        5
 *   the calendar's actionable System-Settings sentence removed always       3
 *   ...and removed entirely, with no reason check to relax                  5
 *   `attempt()` classifies every throw as "unknown", not just untyped ones  2
 *   `calendar.ts` throws a bare `Error` instead of `PermissionRefusedError` 1
 *   `parseWindows`'s refusal comparison loosened to "at least one"         1
 *   `parseTabUrlRefusals` hard-coded to return 0                            3
 *   `loop.ts` drops `tabUrlRefusals` from the `degradedNotice` call         1
 *   `loop.ts` drops `degradedReasons` from the `degradedNotice` call         1
 *   `degradedNotice`'s tab-URL-refusal sentence removed entirely            5
 *   `collectSignals` hard-codes the calendar's counts to 0 and 0             4
 *   `loop.ts` drops `calendarCount`/`calendarRefusedCount` from the update   2
 *   `collectSignals` marks `calendar` degraded on any refusal, not total    2
 *
 * The first of those five is the reason `attempt()` exists: without it, a
 * machine where the person never granted Accessibility throws on every poll,
 * `tick` rejects, and the app silently stops watching for meetings entirely.
 *
 * The next six guard the precision fix on top of it: `attempt()` used to mark
 * the calendar degraded on *any* throw, and `degradedNotice` used to append
 * the write-only guidance whenever it was, so a timeout told the person to go
 * change a permission that was already fine. Two rows are the same mistake
 * measured two ways — always showing the guidance regardless of reason (3,
 * the historical count) versus deleting the reason check *and* the guidance
 * together (5, since more now depends on it) — and the type check on
 * `calendar.ts`'s own throw exists because "it throws" was already covered
 * and "it throws the *right kind*" was not: a bare `Error` there passed every
 * existing check and failed only once this one was added.
 *
 * The last five guard the browser tab-URL count and the reason it travels
 * beside: the window-title refusal comparison (a different guard, sharing the
 * same shape as the calendar's), the count itself hard-coded away, the wiring
 * that carries the count from `collectSignals` through `tick()` into the
 * update a person actually sees, the same wiring for `degradedReasons` — found
 * in review rather than shipped with the fix: a `loop.ts` that forwards
 * `tabUrlRefusals` but drops `degradedReasons` passes every check above it,
 * since none of them calls `tick()` with a real permission refusal — and the
 * sentence that turns a nonzero count into something they read.
 *
 * Both of the two originals are also a note about *this file* rather than
 * about the source. Each of them, on the first attempt, threw out of a bare
 * `await` and killed the rest of the suite — zero FAIL lines, which reads
 * like coverage if you count failures. The collector check now catches and
 * names the escape, and the overlapping-poll check races the second tick
 * against a resolved promise so a missing guard fails instead of hanging. A
 * sabotage is only worth the care taken that it *failed* rather than crashed.
 *
 * **The last three guard the calendar's `calendarCount`/`calendarRefusedCount`
 * pair — the two counts that make "did the collector succeed and find
 * nothing, or was some of it refused?" answerable from outside the app,
 * added to settle a retracted claim rather than to confirm it (see
 * `docs/decisions/desktop-updates.md`, "The one-way door").** Hard-coding
 * `collectSignals`'s own result to `0`/`0` fails both the direct read and the
 * loop's forwarded copy — four lines, not two, because the same wrong answer
 * is asserted at both layers on purpose, the same reason `tabUrlRefusals` is.
 * Dropping the two fields from `loop.ts`'s own `DetectionUpdate` literal
 * fails only the loop's two checks and, separately, fails `tsc`: this is the
 * one guard here with a type-level backstop, since `DetectionUpdate` names
 * both fields as required. The third sabotage is not a missing field but a
 * wrong policy — marking `calendar` degraded (and therefore folding it into
 * `degradedNotice`) whenever `refusedCount` is merely nonzero, not only on a
 * total refusal. That is the mistake this feature exists to avoid: these two
 * numbers are diagnosis, not the panel, and a partial refusal reaching a
 * person as "cannot see your calendar" would be exactly as wrong as the
 * already-guarded case of a timeout naming System Settings.
 */

import { DETECTOR_THRESHOLDS } from "@context/meetings/protocol";
import {
  createDetectionLoop,
  IDLE_DETECTOR_STATE,
} from "../src/core/detection/loop.ts";
import {
  collectSignals,
  failingCollectors,
  fixedCollectors,
  PermissionRefusedError,
  scriptedCollectors,
} from "../src/core/detection/collectors.ts";
import { degradedNotice, evidenceLines } from "../src/core/detection/evidence.ts";
import { fakeClock, referenceDetector } from "./fakes.mjs";

function loopOver(script, options = {}) {
  const clock = fakeClock();
  const detector = referenceDetector(script);
  const updates = [];
  const loop = createDetectionLoop({
    collectors: options.collectors ?? fixedCollectors({ processes: ["zoom.us"] }),
    detector,
    blocklist: () => options.blocklist ?? [],
    enabled: () => options.enabled ?? true,
    now: clock.now,
    onUpdate: (update) => updates.push(update),
  });
  return { loop, updates, clock, detector };
}

async function run(loop, polls) {
  for (let i = 0; i < polls; i += 1) await loop.tick();
}

export async function runDetectionLoopChecks(check) {
  // -- signals -------------------------------------------------------------
  const collected = await collectSignals(fixedCollectors({ processes: ["Zoom"], microphoneInUse: true }), new Date(0));
  check("collectSignals fills the contract's shape", collected.signals.now === "1970-01-01T00:00:00.000Z");
  check("collectSignals passes the processes through", collected.signals.processes[0] === "Zoom");
  check("a working machine reports nothing degraded", collected.degraded.length === 0);

  // Caught rather than awaited bare: a `collectSignals` that lets a collector's
  // rejection escape would otherwise take the rest of this file with it, and a
  // crash reports nothing while looking like detection if you count FAIL lines.
  let broken = null;
  let escaped = null;
  try {
    broken = await collectSignals(failingCollectors(), new Date(0));
  } catch (error) {
    escaped = error;
  }
  check("A COLLECTOR'S FAILURE DOES NOT ESCAPE — it degrades", escaped === null);
  check("a failing collector does not throw", broken?.signals.processes.length === 0);
  check("every failing collector is named", broken?.degraded.length === 4);
  check("a failing microphone collector reads as no evidence, not as a negative", broken?.signals.microphoneInUse === false);
  check("the degraded notice names the calendar", (degradedNotice(broken?.degraded ?? []) ?? "").includes("your calendar"));
  check("nothing degraded means no notice", degradedNotice([]) === null);

  // `failingCollectors()` throws a bare `Error` for every collector — a
  // timeout or a malformed result, never a permission refusal — so it must
  // classify as "unknown" and get none of the calendar's actionable guidance.
  // This is the exact bug closed here: `attempt()` used to mark the calendar
  // degraded on *any* throw and `degradedNotice` used to append the
  // write-only guidance regardless, so a transient failure told the person to
  // go change a permission that was already fine.
  check("an unclassified calendar failure reads as unknown, not a permission refusal", broken?.degradedReasons.calendar === "unknown");
  const transientCalendarNotice = degradedNotice(broken?.degraded ?? [], broken?.degradedReasons ?? {}) ?? "";
  check("a transient calendar failure names the calendar", transientCalendarNotice.includes("your calendar"));
  check(
    "A TRANSIENT CALENDAR FAILURE GETS NO SYSTEM SETTINGS GUIDANCE — it is not a permission refusal",
    !transientCalendarNotice.includes("System Settings"),
  );
  check(
    "a reason-less call is the same honest default — no guidance without a classification",
    !(degradedNotice(["calendar"]) ?? "").includes("System Settings"),
  );

  // A refused Calendars grant is not just "we cannot see it" — the notice has
  // to say what the person can do, and that a fresh ask from this app cannot
  // fix a permission already sitting at write-only. This is the *other* half
  // of the same fix: a genuine `PermissionRefusedError` must still earn the
  // detailed sentence, so the guard is a gate on the reason, not a deletion.
  const calendarNotice = degradedNotice(["calendar"], { calendar: "permission-refused" }) ?? "";
  check("the calendar notice names System Settings", calendarNotice.includes("System Settings"));
  check("the calendar notice names Full Access", calendarNotice.includes("Full Access"));
  check(
    "the calendar notice says a fresh request cannot upgrade an existing grant",
    calendarNotice.toLowerCase().includes("cannot upgrade"),
  );
  check(
    "a collector with no calendar problem gets no System Settings guidance",
    !(degradedNotice(["windows"], { calendar: "permission-refused" }) ?? "").includes("System Settings"),
  );

  // The classification comes from the error's *type*, checked all the way
  // through `collectSignals` — not from a string this test invents.
  {
    const permissionRefusedCollectors = {
      ...fixedCollectors({}),
      calendarEvents: async () => {
        throw new PermissionRefusedError("calendar access refused: every calendar failed to enumerate its events");
      },
    };
    const permissionRefused = await collectSignals(permissionRefusedCollectors, new Date(0));
    check(
      "collectSignals classifies a real PermissionRefusedError as a permission refusal",
      permissionRefused.degradedReasons.calendar === "permission-refused",
    );
    const notice = degradedNotice(permissionRefused.degraded, permissionRefused.degradedReasons) ?? "";
    check("...and the end-to-end notice names System Settings for it", notice.includes("System Settings"));

    const timeoutCollectors = {
      ...fixedCollectors({}),
      calendarEvents: async () => {
        throw new Error("osascript failed");
      },
    };
    const timedOut = await collectSignals(timeoutCollectors, new Date(0));
    check(
      "collectSignals classifies a bare Error (a timeout, here) as unknown",
      timedOut.degradedReasons.calendar === "unknown",
    );
    const timeoutNotice = degradedNotice(timedOut.degraded, timedOut.degradedReasons) ?? "";
    check(
      "...and the end-to-end notice for a timeout says nothing about System Settings",
      !timeoutNotice.includes("System Settings"),
    );
  }

  // -- browser tab URL refusals ---------------------------------------------
  //
  // A browser refusing one poll's tab URL does not degrade the window
  // collector — its titles, including that browser's, are still evidence —
  // so this must be visible with `degraded` staying empty, never by marking
  // `windows` degraded over evidence that was not actually lost.
  {
    check("no tab URL refusals means no notice on their own", degradedNotice([], {}, 0) === null);
    const oneRefusalNotice = degradedNotice([], {}, 1) ?? "";
    check("one tab URL refusal is visible", oneRefusalNotice.length > 0);
    check("...without pretending anything is degraded", !oneRefusalNotice.toLowerCase().includes("cannot see"));
    check(
      "two tab URL refusals are counted as two",
      (degradedNotice([], {}, 2) ?? "").includes("2 open browsers"),
    );
    check(
      "a tab URL refusal notice composes with a genuine degraded notice",
      (degradedNotice(["calendar"], { calendar: "permission-refused" }, 1) ?? "").includes("System Settings") &&
        (degradedNotice(["calendar"], { calendar: "permission-refused" }, 1) ?? "").includes("open tab"),
    );

    const withTabRefusal = await collectSignals(
      fixedCollectors({ processes: ["zoom.us"], tabUrlRefusals: 1 }),
      new Date(0),
    );
    check("a tab URL refusal does not mark the window collector degraded", !withTabRefusal.degraded.includes("windows"));
    check("...and the count still reaches collectSignals' result", withTabRefusal.tabUrlRefusals === 1);
    const tabRefusalNotice = degradedNotice(
      withTabRefusal.degraded,
      withTabRefusal.degradedReasons,
      withTabRefusal.tabUrlRefusals,
    );
    check("...so the person still learns about it", (tabRefusalNotice ?? "").length > 0);

    // The wiring, not just the two functions in isolation: `tick()` is what a
    // real poll calls, and it is the one place `collected.tabUrlRefusals`
    // actually reaches `degradedNotice`. A test that only calls
    // `collectSignals` and `degradedNotice` separately, as above, would not
    // notice `loop.ts` forgetting to pass the count through — measured: it
    // did not, until this check was added.
    const { loop, updates } = loopOver([false], {
      collectors: fixedCollectors({ tabUrlRefusals: 1 }),
    });
    await run(loop, 1);
    check(
      "the running loop's own update carries the tab URL refusal notice",
      (updates[0].degradedNotice ?? "").length > 0,
    );
    check("...and reports no collector as degraded for it", updates[0].degraded.length === 0);

    // The same wiring gap, for `degradedReasons` rather than `tabUrlRefusals`:
    // a real `PermissionRefusedError` from the calendar collector, driven
    // through the actual loop rather than through `collectSignals` and
    // `degradedNotice` called separately. A `loop.ts` that forwards
    // `tabUrlRefusals` but passes `{}` (or nothing) for `degradedReasons`
    // would still pass the check above — measured: it did, until this one was
    // added — because that check's fixture has no calendar failure in it at
    // all.
    const permissionRefusedLoop = loopOver([false], {
      collectors: {
        ...fixedCollectors({ processes: ["zoom.us"] }),
        calendarEvents: async () => {
          throw new PermissionRefusedError("calendar access refused: every calendar failed to enumerate its events");
        },
      },
    });
    await run(permissionRefusedLoop.loop, 1);
    check(
      "the running loop's own update carries the calendar's permission-refusal reason, not just its name",
      (permissionRefusedLoop.updates[0].degradedNotice ?? "").includes("System Settings"),
    );
  }

  // -- calendar calendars-seen / refused counts -----------------------------
  //
  // The question an empty result cannot answer on its own: did the collector
  // succeed and find nothing, or was some or all of it refused? These two
  // counts are what settles that from outside the app, without ever naming a
  // calendar or an event — see `docs/decisions/desktop-updates.md`, "The
  // one-way door", for why this was left unknown rather than confirmed.
  {
    const clean = await collectSignals(
      fixedCollectors({ processes: ["zoom.us"], calendarCount: 2, calendarRefusedCount: 0 }),
      new Date(0),
    );
    check("a clean poll's calendar counts reach collectSignals' result", clean.calendarCount === 2 && clean.calendarRefusedCount === 0);
    check("a clean poll is not degraded", !clean.degraded.includes("calendar"));

    // The case this file exists for: some calendars answered, at least one
    // refused, and the collector does not throw — the shape a genuine
    // partial refusal produces (see `parseCalendarEvents`). This must still
    // reach the result as a real, nonzero count, not be silently rounded into
    // the "no refusals" case above.
    const partial = await collectSignals(
      fixedCollectors({ processes: ["zoom.us"], calendarCount: 3, calendarRefusedCount: 1 }),
      new Date(0),
    );
    check(
      "a partial calendar refusal's counts reach collectSignals' result",
      partial.calendarCount === 3 && partial.calendarRefusedCount === 1,
    );
    check("a partial calendar refusal does not mark the calendar degraded", !partial.degraded.includes("calendar"));

    // A total refusal throws before any count is returned; `collectSignals`
    // falls back to zero and zero for both. This is not a loss: a total
    // refusal is already visible through `degraded`/`degradedReasons`, and
    // the counts exist for exactly the case that is not visible any other
    // way.
    const totalRefusal = await collectSignals(
      {
        ...fixedCollectors({ processes: ["zoom.us"] }),
        calendarEvents: async () => {
          throw new PermissionRefusedError("calendar access refused: every calendar failed to enumerate its events");
        },
      },
      new Date(0),
    );
    check(
      "a total calendar refusal falls back to zero and zero rather than a stale count",
      totalRefusal.calendarCount === 0 && totalRefusal.calendarRefusedCount === 0,
    );
    check("...and is still visible through degraded, so nothing about it is lost", totalRefusal.degraded.includes("calendar"));

    // The wiring, not just `collectSignals` in isolation: `tick()` is what a
    // real poll calls, and it is the one place these two counts would be
    // silently dropped on the way to `DetectionUpdate` if `loop.ts` forgot to
    // forward them — the exact shape of gap this file already found once for
    // `tabUrlRefusals` and `degradedReasons`.
    const { loop, updates } = loopOver([false], {
      collectors: fixedCollectors({ calendarCount: 2, calendarRefusedCount: 1 }),
    });
    await run(loop, 1);
    check("the running loop's own update carries the calendar count", updates[0].calendarCount === 2);
    check("...and the refused count", updates[0].calendarRefusedCount === 1);

    // These counts are diagnosis, not the panel: a partial refusal must never
    // make its way into the one sentence a person actually reads.
    check(
      "a partial calendar refusal earns no notice on its own — it is not shown to a person",
      updates[0].degradedNotice === null,
    );
  }

  // -- the edges -----------------------------------------------------------
  {
    const { loop, updates } = loopOver([true, true, true, true]);
    await run(loop, 1);
    check("one positive poll does not activate", updates[0].state.active === false);
    check("one positive poll reports no transition", updates[0].transition === "none");
    await run(loop, 1);
    check(`${DETECTOR_THRESHOLDS.toActive} positive polls activate`, updates[1].state.active === true);
    check("activation is reported as an edge", updates[1].transition === "activated");
    await run(loop, 2);
    check("a running meeting does not re-report activation", updates[2].transition === "none" && updates[3].transition === "none");
  }

  // -- the flicker that must not start a recording -------------------------
  {
    const { loop, updates } = loopOver([true, false, true, false, true, false]);
    await run(loop, 6);
    check("an app that flickers on and off never activates", updates.every((update) => update.state.active === false));
    check("a flicker produces no activated edge", updates.every((update) => update.transition !== "activated"));
  }

  // -- the blip that must not end one --------------------------------------
  {
    const { loop, updates } = loopOver([true, true, false, false, true, true, true]);
    await run(loop, 7);
    check("a two-poll blip does not clear an active meeting", updates.slice(1).every((update) => update.state.active === true));
    check("a two-poll blip produces no cleared edge", updates.every((update) => update.transition !== "cleared"));
  }

  // -- and the ending that must ----------------------------------------------
  {
    const { loop, updates } = loopOver([true, true, false, false, false, false]);
    await run(loop, 6);
    const cleared = updates.filter((update) => update.transition === "cleared");
    check(`${DETECTOR_THRESHOLDS.toInactive} negative polls clear the meeting`, cleared.length === 1);
    check("the clear is the last poll", updates[updates.length - 1].transition === "cleared");
    check("a cleared detector has no source", updates[updates.length - 1].state.source === null);
  }

  // -- the blocklist, before the detector ------------------------------------
  {
    const seen = [];
    const clock = fakeClock();
    const detector = {
      detect(signals) {
        seen.push(signals);
        return { detected: false, confidence: 0, source: { kind: "unknown" }, reason: "", suggestedTitle: null, suggestedAttendees: [] };
      },
      nextDetectorState: (prev) => prev,
    };
    const loop = createDetectionLoop({
      collectors: fixedCollectors({
        processes: ["zoom.us", "Slack"],
        windows: [{ app: "zoom.us", title: "A private call" }, { app: "Slack", title: "general" }],
      }),
      detector,
      blocklist: () => ["zoom"],
      enabled: () => true,
      now: clock.now,
    });
    await loop.tick();
    check("the detector never sees a blocked process", !seen[0].processes.includes("zoom.us"));
    check("the detector never sees a blocked window", seen[0].windows.every((w) => w.app !== "zoom.us"));
    check("the detector still sees everything else", seen[0].processes.includes("Slack"));
    check("a blocked window title reaches nothing", !JSON.stringify(seen).includes("A private call"));
  }

  // -- the blocklist is read fresh, so turning it on applies now --------------
  {
    let blocklist = [];
    const seen = [];
    const loop = createDetectionLoop({
      collectors: fixedCollectors({ processes: ["zoom.us"] }),
      detector: {
        detect: (signals) => {
          seen.push(signals.processes.length);
          return { detected: false, confidence: 0, source: { kind: "unknown" }, reason: "", suggestedTitle: null, suggestedAttendees: [] };
        },
        nextDetectorState: (prev) => prev,
      },
      blocklist: () => blocklist,
      enabled: () => true,
    });
    await loop.tick();
    blocklist = ["zoom"];
    await loop.tick();
    check("adding to the blocklist applies on the next poll", seen[0] === 1 && seen[1] === 0);
  }

  // -- switched off ----------------------------------------------------------
  {
    const { loop, updates } = loopOver([true, true, true], { enabled: false });
    await run(loop, 3);
    check("detection switched off polls nothing", updates.length === 0);
    check("detection switched off leaves the state idle", loop.state() === IDLE_DETECTOR_STATE);
  }

  // -- overlapping polls -----------------------------------------------------
  {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const collectors = {
      ...fixedCollectors({ processes: ["zoom.us"] }),
      processes: async () => {
        calls += 1;
        await gate;
        return ["zoom.us"];
      },
    };
    const { loop } = loopOver([true, true, true], { collectors });
    const first = loop.tick();
    // Raced against a resolved promise rather than awaited: without the guard
    // the second poll blocks on the same gate and this check would hang the
    // suite instead of failing it, which is a worse signal than either.
    const second = await Promise.race([loop.tick(), Promise.resolve("still running")]);
    check("a poll that is still running is not started again", second === null && calls === 1);
    release();
    await first;
  }

  // -- what the panel renders -------------------------------------------------
  {
    const { loop, updates } = loopOver([true, true]);
    await run(loop, 2);
    const update = updates[1];
    check("the evidence list is the detector's reason, split", update.evidence.length >= 1);
    check("the summary is the whole reason", update.summary.length > 0);
    check("a one-sentence reason is one evidence line", evidenceLines({ reason: "Zoom is running" }).length === 1);
    check(
      "a separated reason becomes the mockup's ticked list",
      evidenceLines({ reason: "Zoom is running; a calendar event started; the join link matches" }).length === 3,
    );
    check("an empty reason produces no evidence", evidenceLines({ reason: "" }).length === 0);
    check("a non-string reason does not throw", evidenceLines({ reason: undefined }).length === 0);
  }

  // -- the scripted collectors advance once per poll, not once per question ---
  {
    const collectors = scriptedCollectors([{ processes: ["a"] }, { processes: ["b"] }]);
    const first = await collectSignals(collectors, new Date(0));
    const second = await collectSignals(collectors, new Date(0));
    check("a scripted poll is one script frame", first.signals.processes[0] === "a" && second.signals.processes[0] === "b");
  }

  // -- a throwing detector must not kill the timer ----------------------------
  {
    const loop = createDetectionLoop({
      collectors: fixedCollectors({}),
      detector: {
        detect: () => { throw new Error("detect blew up"); },
        nextDetectorState: (prev) => prev,
      },
      blocklist: () => [],
      enabled: () => true,
      timers: { setInterval: (fn) => fn, clearInterval: () => {} },
    });
    let threw = false;
    try {
      await loop.tick();
    } catch {
      threw = true;
    }
    check("a detector that throws surfaces to the caller", threw);
    // ...and the loop is still usable afterwards, rather than stuck in-flight.
    let secondThrew = false;
    try {
      await loop.tick();
    } catch {
      secondThrew = true;
    }
    check("a throwing poll releases the in-flight guard", secondThrew);
  }

  // -- start/stop ------------------------------------------------------------
  {
    let interval = null;
    const loop = createDetectionLoop({
      collectors: fixedCollectors({}),
      detector: referenceDetector([false]),
      blocklist: () => [],
      enabled: () => true,
      timers: {
        setInterval: (fn, ms) => { interval = { fn, ms }; return interval; },
        clearInterval: () => { interval = null; },
      },
    });
    loop.start();
    check("the loop polls on the contract's interval", interval?.ms === DETECTOR_THRESHOLDS.pollMs);
    check("the loop reports itself running", loop.running === true);
    loop.start();
    check("starting twice does not stack timers", loop.running === true);
    loop.stop();
    check("stopping clears the timer", interval === null && loop.running === false);
  }
}
