/**
 * IS THIS A MEETING? — `src/detect.js`.
 *
 * The rules decide whether to start recording somebody's conversation, so the
 * ways they must be wrong are asymmetric and both are tested here:
 *
 * - **False positives are the expensive kind.** Slack, Discord and Teams are
 *   always running; their process existing means nothing. A browser tab titled
 *   "Slack huddle etiquette" is not a huddle. A microphone in use is a voice
 *   memo as often as it is a meeting.
 * - **False negatives lose the product.** An in-person meeting — no app, no
 *   window, an invite with other people on it happening right now — is a real
 *   meeting, and half the value is gone if only the ones with a URL count.
 *
 * Then the hysteresis, which is what stops one bad poll from starting or
 * stopping a recording. Those cases are enumerated one poll at a time rather
 * than asserted in aggregate, because "flicker" is exactly the bug that a
 * summary assertion hides.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   in-person firing on a solo calendar block                                5
 *   `requiresWindowEvidence` ignored                                         4
 *   in-person detection removed                                              4
 *   `nextDetectorState` clearing on the first negative                       4
 *   the hysteresis counters never resetting                                  4
 *   a microphone in use deciding on its own                                  3
 *   the conference-URL confirmation removed                                  3
 *   `sameConference` matching on host alone                                  3
 *   `nextDetectorState` firing on the first positive                         3
 *   `nextDetectorState` mutating the state it was given                      3
 *   the calendar window ignoring `calendarLeadMs`                            2
 *   the calendar window ignoring `calendarTrailMs`                           2
 *   a foreign browser tab's title counting as its app                        2
 *   the always-running app guard dropped                                     1
 *
 * `requiresWindowEvidence` scored **zero** to begin with, and the reason is
 * worth keeping: an app-only match already scores below the threshold, so
 * removing the guard changed no verdict in any fixture the suite had. It
 * changes one the moment a calendar event is also in the poll — Slack open,
 * as it always is, plus a meeting on the calendar, adds up past the threshold
 * and claims a huddle that is not happening. That fixture is now here, and it
 * is the case the rule exists for.
 */

import { DETECTOR_THRESHOLDS } from "../src/protocol.js";
import {
  CONFIRMED_CONFIDENCE,
  DETECTION_RULES,
  DETECT_MIN_CONFIDENCE,
  activeCalendarEvents,
  detect,
  initialDetectorState,
  matchRules,
  nextDetectorState,
  normalizeProcessName,
  sameConference,
  sourceKindForUrl,
} from "../src/detect.js";
import { at, calendarEvent, deepEqual, signals } from "./fixtures.mjs";

/** Every kind the brief names must have a rule. */
const REQUIRED_KINDS = ["zoom", "meet", "teams", "slack-huddle", "webex", "discord", "facetime"];

export function runDetectChecks(check) {
  /* ------------------------------ the table ----------------------------- */

  for (const kind of REQUIRED_KINDS) {
    check(`there is a rule for ${kind}`, DETECTION_RULES.some((rule) => rule.kind === kind));
  }
  check("every rule carries a weight between 0 and 1", DETECTION_RULES.every((rule) => rule.weight > 0 && rule.weight <= 1));
  check("every rule carries a reason a person could read", DETECTION_RULES.every((rule) => typeof rule.reason === "string" && rule.reason.length > 10));
  check("every rule carries a label", DETECTION_RULES.every((rule) => typeof rule.label === "string" && rule.label.length > 0));
  check("the table is frozen, so a caller cannot edit the rules under us", Object.isFrozen(DETECTION_RULES));

  check("a process path is reduced to its name", normalizeProcessName("/Applications/zoom.us.app/Contents/MacOS/CptHost") === "cpthost");
  check("...on Windows too", normalizeProcessName("C:\\Program Files\\Zoom\\bin\\Zoom.exe") === "zoom");
  check("a non-string process does not throw", normalizeProcessName(null) === "");

  /* -------------------------------- Zoom -------------------------------- */

  const zoom = detect(signals({ processes: ["CptHost"], windows: [{ app: "zoom.us", title: "Zoom Meeting" }] }));
  check("Zoom's meeting process is a detection", zoom.detected && zoom.source.kind === "zoom");
  check("...with a reason for the tray tooltip", zoom.reason.length > 0);
  check("...and the app it matched, kept as evidence", zoom.source.app === "zoom.us");
  check(
    "the Zoom client sitting idle in the dock is not a meeting",
    !detect(signals({ processes: [], windows: [{ app: "zoom.us", title: "Zoom" }] })).detected
  );

  /* ----------------------------- Google Meet ---------------------------- */

  const meet = detect(signals({ windows: [{ app: "Example Browser", title: "Meet", url: "https://meet.google.com/aaa-bbbb-ccc" }] }));
  check("a Meet tab is a detection", meet.detected && meet.source.kind === "meet");
  check("...and the tab URL is kept", meet.source.url === "https://meet.google.com/aaa-bbbb-ccc");
  check(
    "a page that merely mentions Meet is not",
    !detect(signals({ windows: [{ app: "Example Browser", title: "How to use Google Meet", url: "https://example.test/blog" }] })).detected
  );
  check("a subdomain of a known host still matches", sourceKindForUrl("https://us02web.zoom.us/j/123") === "zoom");
  check("an unrelated host matches nothing", sourceKindForUrl("https://example.test/j/123") === "unknown");
  check("a malformed URL does not throw", sourceKindForUrl("not a url") === "unknown");

  /* ----------------------------- Slack huddles -------------------------- */

  check(
    "Slack running is not a huddle",
    !detect(signals({ processes: ["Slack"], windows: [{ app: "Slack", title: "general - Example Workspace" }] })).detected
  );
  const huddle = detect(signals({ processes: ["Slack"], windows: [{ app: "Slack", title: "Huddle - #general" }] }));
  check("a Slack window titled Huddle is", huddle.detected && huddle.source.kind === "slack-huddle");
  check(
    "...but a browser tab about huddles is not",
    !detect(signals({ windows: [{ app: "Example Browser", title: "Slack huddle etiquette", url: "https://example.test/post" }] })).detected
  );
  check(
    "...nor a tab about Zoom meetings",
    detect(signals({ windows: [{ app: "Example Browser", title: "Zoom Meeting checklist", url: "https://example.test/post" }] })).source.kind !== "zoom"
  );
  check(
    "...nor a tab about Teams meetings",
    detect(signals({ windows: [{ app: "Example Browser", title: "Teams meeting tips", url: "https://example.test/post" }] })).source.kind !== "teams"
  );
  // The case the always-running rule exists for: Slack is open, as it always
  // is, and there is a meeting on the calendar. Without the rule the two add up
  // past the threshold and the recorder claims a huddle that is not happening.
  const slackDuringMeeting = detect(signals({
    processes: ["Slack"],
    windows: [{ app: "Slack", title: "general - Example Workspace" }],
    calendarEvents: [calendarEvent()],
  }));
  check("Slack merely open during a calendar meeting is not a huddle", slackDuringMeeting.source.kind !== "slack-huddle");
  check("...it is the in-person meeting the calendar describes", slackDuringMeeting.source.kind === "in-person");
  check(
    "Teams merely open during a calendar meeting is not a Teams meeting",
    detect(signals({
      processes: ["Teams"],
      windows: [{ app: "Microsoft Teams", title: "Chat | Microsoft Teams" }],
      calendarEvents: [calendarEvent()],
    })).source.kind !== "teams"
  );
  check(
    "Discord merely open during a calendar meeting is not a call",
    detect(signals({
      windows: [{ app: "Discord", title: "#general | Example" }],
      calendarEvents: [calendarEvent()],
    })).source.kind !== "discord"
  );

  /* -------------------------- Teams, Webex, the rest -------------------- */

  check(
    "Teams idle is not a meeting",
    !detect(signals({ processes: ["Teams"], windows: [{ app: "Microsoft Teams", title: "Chat | Microsoft Teams" }] })).detected
  );
  check(
    "a Teams meeting window is",
    detect(signals({ windows: [{ app: "Microsoft Teams", title: "Meeting with the team | Microsoft Teams" }] })).source.kind === "teams"
  );
  check(
    "the Webex meeting client is a detection on its process alone",
    detect(signals({ processes: ["webexmta"] })).source.kind === "webex"
  );
  check(
    "Discord running is not a call",
    !detect(signals({ processes: ["Discord"], windows: [{ app: "Discord", title: "#general | Example" }] })).detected
  );
  check(
    "a connected Discord voice window is",
    detect(signals({ windows: [{ app: "Discord", title: "Voice Connected | Example" }] })).source.kind === "discord"
  );
  check(
    "FaceTime in a call is a detection",
    detect(signals({ processes: ["FaceTime"], windows: [{ app: "FaceTime", title: "FaceTime" }] })).source.kind === "facetime"
  );

  /* ------------------------------ microphone ---------------------------- */

  const micOnly = detect(signals({ microphoneInUse: true }));
  check("a microphone in use, alone, is not a meeting", !micOnly.detected);
  check("...and is not even close to the threshold", micOnly.confidence < DETECT_MIN_CONFIDENCE / 2);
  check(
    "a microphone in use during a solo calendar block is still not a meeting",
    !detect(signals({ microphoneInUse: true, calendarEvents: [calendarEvent({ title: "Focus time", attendees: [{ name: "Attendee One" }] })] })).detected
  );
  check("...but it is mentioned, because it is why the confidence moved", micOnly.reason.includes("microphone"));
  const micPlus = detect(signals({ processes: ["CptHost"], microphoneInUse: true }));
  check("...and it corroborates something that already looks like one", micPlus.confidence > detect(signals({ processes: ["CptHost"] })).confidence);

  /* ------------------------------- calendar ----------------------------- */

  const lead = DETECTOR_THRESHOLDS.calendarLeadMs;
  const trail = DETECTOR_THRESHOLDS.calendarTrailMs;
  check(
    "an event is active from lead before it starts",
    activeCalendarEvents(signals({ now: new Date(Date.parse(at(0)) - lead + 1000).toISOString(), calendarEvents: [calendarEvent()] })).length === 1
  );
  check(
    "...but not a moment earlier",
    activeCalendarEvents(signals({ now: new Date(Date.parse(at(0)) - lead - 1000).toISOString(), calendarEvents: [calendarEvent()] })).length === 0
  );
  check(
    "...until trail after it ends",
    activeCalendarEvents(signals({ now: new Date(Date.parse(at(30)) + trail - 1000).toISOString(), calendarEvents: [calendarEvent()] })).length === 1
  );
  check(
    "...and not a moment later",
    activeCalendarEvents(signals({ now: new Date(Date.parse(at(30)) + trail + 1000).toISOString(), calendarEvents: [calendarEvent()] })).length === 0
  );
  check(
    "a meeting app running before the invite starts gets the calendar's help",
    detect(signals({
      now: new Date(Date.parse(at(0)) - lead + 1000).toISOString(),
      processes: ["CptHost"],
      calendarEvents: [calendarEvent()],
    })).suggestedTitle === "Weekly sync"
  );
  check(
    "...and does not, a minute before that window opens",
    detect(signals({
      now: new Date(Date.parse(at(0)) - lead - 60_000).toISOString(),
      processes: ["CptHost"],
      calendarEvents: [calendarEvent()],
    })).suggestedTitle === null
  );
  check(
    "a meeting that ran over still gets the calendar's help",
    detect(signals({
      now: new Date(Date.parse(at(30)) + trail - 1000).toISOString(),
      processes: ["CptHost"],
      calendarEvents: [calendarEvent()],
    })).suggestedTitle === "Weekly sync"
  );
  check(
    "...but not an hour after everyone left",
    detect(signals({
      now: new Date(Date.parse(at(30)) + trail + 60_000).toISOString(),
      processes: ["CptHost"],
      calendarEvents: [calendarEvent()],
    })).suggestedTitle === null
  );
  check(
    "an event with unparseable times is ignored rather than throwing",
    activeCalendarEvents(signals({ calendarEvents: [calendarEvent({ startsAt: "soon", endsAt: "later" })] })).length === 0
  );

  const corroborated = detect(signals({ processes: ["CptHost"], calendarEvents: [calendarEvent()] }));
  const uncorroborated = detect(signals({ processes: ["CptHost"] }));
  check("a calendar event raises confidence", corroborated.confidence > uncorroborated.confidence);
  check("...and supplies a title", corroborated.suggestedTitle === "Weekly sync");
  check("...and the attendees, marked as coming from the calendar", corroborated.suggestedAttendees.length === 2 && corroborated.suggestedAttendees[0].via === "calendar");
  check("...and the event id, so the note can be traced back", corroborated.source.calendarEventId === "evt-1");
  check(
    "a calendar event alone is not enough to start recording",
    !detect(signals({ calendarEvents: [calendarEvent({ attendees: [{ name: "Attendee One" }] })] })).detected
  );

  /* ------------------- the strongest signal there is --------------------- */

  const confirmed = detect(
    signals({
      windows: [{ app: "Example Browser", title: "Meet", url: "https://meet.google.com/aaa-bbbb-ccc?authuser=0" }],
      calendarEvents: [calendarEvent({ conferenceUrl: "https://meet.google.com/aaa-bbbb-ccc" })],
    })
  );
  check("the invite's link, open right now, is the strongest signal", confirmed.confidence === CONFIRMED_CONFIDENCE);
  check(
    "...beating the same tab with no invite behind it",
    confirmed.confidence > detect(signals({ windows: [{ app: "Example Browser", title: "Meet", url: "https://meet.google.com/aaa-bbbb-ccc" }] })).confidence
  );
  check(
    "...and beating the same tab and invite treated only as corroboration",
    confirmed.confidence > detect(signals({
      windows: [{ app: "Example Browser", title: "Meet", url: "https://meet.google.com/aaa-bbbb-ccc" }],
      calendarEvents: [calendarEvent({ conferenceUrl: "https://meet.google.com/zzz-zzzz-zzz" })],
    })).confidence
  );
  check("...higher than anything inferred", confirmed.confidence > detect(signals({ processes: ["CptHost"], calendarEvents: [calendarEvent()] })).confidence);
  check("...and it names the event in its reason", confirmed.reason.includes("Weekly sync"));
  check("...ties the note to the calendar event", confirmed.source.calendarEventId === "evt-1");
  check("...and gets the source kind from the link", confirmed.source.kind === "meet");

  check("query strings do not stop two links being the same conference", sameConference("https://meet.google.com/a-b-c?pli=1", "https://meet.google.com/a-b-c"));
  check("a trailing slash does not either", sameConference("https://example.test/j/123/", "https://example.test/j/123"));
  check("a different host is a different conference", !sameConference("https://meet.google.com/a-b-c", "https://example.test/a-b-c"));
  check("a different path is a different conference", !sameConference("https://meet.google.com/a-b-c", "https://meet.google.com/x-y-z"));
  check("a bare host matches nothing, or every tab would be a meeting", !sameConference("https://meet.google.com/", "https://meet.google.com/a-b-c"));
  check("a missing link is not a match", !sameConference(undefined, "https://meet.google.com/a-b-c"));

  /* ------------------------------ in person ----------------------------- */

  const inPerson = detect(signals({ calendarEvents: [calendarEvent()] }));
  check("an invite with people and no link, happening now, is a meeting", inPerson.detected);
  check("...recorded as in-person", inPerson.source.kind === "in-person");
  check("...with the invite's title and attendees", inPerson.suggestedTitle === "Weekly sync" && inPerson.suggestedAttendees.length === 2);
  check("...and a reason that explains itself", inPerson.reason.includes("no link to join"));
  check(
    "a solo calendar block is not a meeting",
    !detect(signals({ calendarEvents: [calendarEvent({ title: "Focus time", attendees: [{ name: "Attendee One" }] })] })).detected
  );
  check(
    "an invite with a link nobody opened is not in-person",
    detect(signals({ calendarEvents: [calendarEvent({ conferenceUrl: "https://meet.google.com/a-b-c" })] })).source.kind !== "in-person"
  );
  check(
    "...and is not a detection either, because nobody joined",
    !detect(signals({ calendarEvents: [calendarEvent({ conferenceUrl: "https://meet.google.com/a-b-c" })] })).detected
  );
  check(
    "an app in front wins over the in-person guess",
    detect(signals({ processes: ["CptHost"], calendarEvents: [calendarEvent()] })).source.kind === "zoom"
  );

  /* -------------------------------- nothing ----------------------------- */

  const quiet = detect(signals());
  check("an empty poll detects nothing", !quiet.detected && quiet.confidence === 0);
  check("...with an unknown source", quiet.source.kind === "unknown");
  check("...and says so in words", quiet.reason === "nothing that looks like a meeting");
  check("...and suggests nothing", quiet.suggestedTitle === null && quiet.suggestedAttendees.length === 0);
  check("garbage signals do not throw", detect(null).detected === false);
  check("half-built signals do not throw", detect({ now: at(0) }).detected === false);
  check("a window with no title does not throw", detect(signals({ windows: [{ app: "Example App" }] })).detected === false);
  check("matchRules returns the strongest first", (() => {
    const matches = matchRules(signals({ processes: ["CptHost"], windows: [{ app: "Example Browser", title: "Meet", url: "https://meet.google.com/a-b-c" }] }));
    return matches.length >= 2 && matches[0].score >= matches[1].score;
  })());
  check("the detection threshold is what `detected` actually means", detect(signals({ processes: ["CptHost"] })).confidence >= DETECT_MIN_CONFIDENCE);

  /* ------------------------------ hysteresis ---------------------------- */

  const yes = { detected: true, confidence: 0.9, source: { kind: "zoom" }, reason: "z", suggestedTitle: null, suggestedAttendees: [] };
  const no = { detected: false, confidence: 0, source: { kind: "unknown" }, reason: "n", suggestedTitle: null, suggestedAttendees: [] };
  const poll = (state, result, time) => nextDetectorState(state, result, time);

  const zero = initialDetectorState();
  check("the detector starts inactive", !zero.active && zero.positives === 0 && zero.negatives === 0);
  check("...with no source and no start time", zero.source === null && zero.since === null);

  const one = poll(zero, yes, at(0));
  check("ONE positive poll does not start a recording", !one.active);
  check("...though it is counted", one.positives === 1);
  const two = poll(one, yes, at(1));
  check("two agreeing polls do", two.active);
  check("...recording when, and what", two.since === at(1) && two.source?.kind === "zoom");
  check("the threshold is the one in the protocol", DETECTOR_THRESHOLDS.toActive === 2);

  // The flicker that matters: a single bad poll between two good ones.
  const flickerOff = poll(poll(zero, yes, at(0)), no, at(1));
  check("a negative poll resets the run, so a flicker cannot start a recording", flickerOff.positives === 0);
  check("...and one more positive is still not enough", !poll(flickerOff, yes, at(2)).active);
  check("...but two more are", poll(poll(flickerOff, yes, at(2)), yes, at(3)).active);

  let active = two;
  active = poll(active, no, at(2));
  check("ONE negative poll does not stop a live recording", active.active);
  active = poll(active, no, at(3));
  check("...nor two", active.active);
  active = poll(active, no, at(4));
  check("...nor three", active.active);
  active = poll(active, no, at(5));
  check("...but four do", !active.active);
  check("the threshold is the one in the protocol", DETECTOR_THRESHOLDS.toInactive === 4);
  check("...and stopping clears the source and the start time", active.source === null && active.since === null);

  // A blip mid-meeting: the negatives must reset, or a long meeting with
  // occasional missed polls would end itself.
  let blipping = two;
  for (const result of [no, no, no, yes, no, no, no]) blipping = poll(blipping, result, at(9));
  check("a positive poll resets the negatives, so a blip cannot end a recording", blipping.active);

  check(
    "the counters are capped, because this struct crosses to the watch",
    (() => {
      let state = initialDetectorState();
      for (let i = 0; i < 500; i += 1) state = poll(state, yes, at(i));
      return state.positives <= DETECTOR_THRESHOLDS.toActive;
    })()
  );
  check(
    "a live recording keeps the source it started with",
    poll(two, { ...yes, source: { kind: "meet" } }, at(3)).source?.kind === "zoom"
  );
  check("nextDetectorState never mutates the state it is given", (() => {
    const before = initialDetectorState();
    const snapshot = { ...before };
    poll(before, yes, at(0));
    return deepEqual(before, snapshot);
  })());
  check("a missing previous state is treated as the initial one", nextDetectorState(null, yes, at(0)).positives === 1);
  check("a missing result counts as a negative, not a crash", nextDetectorState(zero, null, at(0)).negatives === 1);
}
