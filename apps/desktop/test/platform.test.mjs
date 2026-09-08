/**
 * The macOS collectors' parsers, against fixtures.
 *
 * The collectors themselves shell out to `ps`, `ioreg` and `osascript` and
 * cannot run in CI — but the parsing and the redaction can, and those are where
 * the mistakes with consequences live: a URL that keeps its query string, a
 * missing audio class read as "nobody is on a call", a JSON parse that throws
 * on a window title with a quote in it.
 *
 * Fixtures are obviously fake: `example.test` is a reserved TLD and the names
 * are inventions.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   `redactUrl` returning the raw URL                                        6
 *   `readingToSignal` answering `false` when no audio engines are visible     1
 *   `parseCalendarEvents`'s total-refusal throw removed                       1
 *   `parseWindows`'s total-refusal throw removed                              1
 *
 * The first number is high because the redaction is asserted in three places —
 * the window parser, the calendar parser, and "no passcode reaches the
 * signals" — which is the right amount for the one thing in this folder that
 * would leak a meeting passcode into a log. The last two guard the defect this
 * app actually shipped: a write-only Calendars grant (Apple Events to
 * Calendar allowed, the data refused) read as a quiet hour rather than a
 * refusal, because the per-item `catch` swallowed the refusal into the same
 * empty result an idle collector produces. Both parsers now count attempts and
 * refusals and throw only on a *total* refusal, which is why each sabotage is
 * one line — removing the whole check, not narrowing a condition — and one
 * FAILURE, on the fixture built for exactly that shape.
 */

import { parseProcessList } from "../src/platform/macos/processes.ts";
import { parseWindows, redactUrl } from "../src/platform/macos/windows.ts";
import { parseEngineState, readingToSignal } from "../src/platform/macos/microphone.ts";
import { calendarWindow, parseCalendarEvents } from "../src/platform/macos/calendar.ts";
import { DETECTOR_THRESHOLDS } from "@context/meetings/protocol";

export function runPlatformChecks(check) {
  // -- ps --------------------------------------------------------------------
  {
    const names = parseProcessList("zoom.us\nGoogle Chrome\n/usr/libexec/some-helper\nzoom.us\n\n");
    check("process names are the leaf", names.includes("some-helper"));
    check("duplicates are collapsed", names.filter((name) => name === "zoom.us").length === 1);
    check("blank lines are dropped", !names.includes(""));
    check("an empty ps output is an empty list", parseProcessList("").length === 0);
  }

  // -- URLs: the redaction ---------------------------------------------------
  {
    check(
      "a conference URL keeps origin and path",
      redactUrl("https://meet.example.test/abc-defg-hij") === "https://meet.example.test/abc-defg-hij",
    );
    check(
      "A QUERY STRING IS DROPPED",
      redactUrl("https://meet.example.test/abc?authuser=1&pli=secret") === "https://meet.example.test/abc",
    );
    check("a fragment is dropped", redactUrl("https://example.test/doc#heading") === "https://example.test/doc");
    check("a non-http scheme is refused", redactUrl("file:///Users/someone/Documents/private.md") === undefined);
    check("nonsense is refused", redactUrl("not a url") === undefined);
  }

  // -- window titles ---------------------------------------------------------
  {
    const stdout = JSON.stringify({
      windows: [
        { app: "zoom.us", title: 'Zoom Meeting — "Design review", Portal', focused: true },
        { app: "Google Chrome", title: "Calendar", url: "https://calendar.example.test/r?tok=secret", focused: false },
        { app: "", title: "orphan" },
        { app: "Notes", title: null },
      ],
      titleAttempts: 4,
      titleRefusals: 0,
    });
    const windows = parseWindows(stdout);
    check("a title with quotes survives", windows[0].title.includes('"Design review"'));
    check("the focused flag is carried", windows[0].focused === true);
    check("a tab URL is redacted on the way in", windows[1].url === "https://calendar.example.test/r");
    check("a token in a tab URL never reaches the signals", !JSON.stringify(windows).includes("secret"));
    check("a window with no app is dropped", windows.every((w) => w.app !== ""));
    check("a null title becomes an empty string", windows.some((w) => w.app === "Notes" && w.title === ""));
    check("an unfocused window carries no focused flag", windows[1].focused === undefined);

    let threw = false;
    try {
      parseWindows("osascript: execution error: not authorised (-1743)");
    } catch {
      threw = true;
    }
    check("a permission error throws rather than reading as no windows", threw);

    // A collector that is legitimately idle: some processes were asked for
    // window titles, none of them refused, and none of them had any windows.
    const idleWindows = parseWindows(
      JSON.stringify({ windows: [], titleAttempts: 3, titleRefusals: 0 }),
    );
    check("no windows found, with no refusals, is a quiet moment, not a refusal", idleWindows.length === 0);

    // A collector Accessibility has entirely refused: every process asked for
    // its window titles refused, and nothing was collected as a result. This
    // must not read the same as the idle case above.
    let refusalThrew = false;
    try {
      parseWindows(JSON.stringify({ windows: [], titleAttempts: 3, titleRefusals: 3 }));
    } catch {
      refusalThrew = true;
    }
    check(
      "every title read refusing, with nothing collected, throws rather than reading as no windows open",
      refusalThrew,
    );

    // A partial refusal — some processes' titles came back, one browser's tab
    // URL did not — must still read as ordinary evidence, not a collector
    // failure: the titles collected are real and must not be discarded.
    const partialWindows = parseWindows(
      JSON.stringify({
        windows: [{ app: "zoom.us", title: "Weekly sync", focused: true }],
        titleAttempts: 3,
        titleRefusals: 2,
      }),
    );
    check(
      "a partial title refusal that still found something is not treated as a total refusal",
      partialWindows.length === 1 && partialWindows[0].app === "zoom.us",
    );
  }

  // -- the microphone --------------------------------------------------------
  {
    const idle = parseEngineState('"IOAudioEngineState" = 0\n"IOAudioEngineState" = 0\n');
    check("two idle engines read as two engines", idle.engines === 2 && idle.running === 0);
    check("idle engines are a real negative", readingToSignal(idle) === false);

    const busy = parseEngineState('"IOAudioEngineState" = 0\n"IOAudioEngineState" = 1\n');
    check("a running engine is a positive", readingToSignal(busy) === true);

    let threw = false;
    try {
      readingToSignal(parseEngineState(""));
    } catch {
      threw = true;
    }
    check("NO ENGINES AT ALL IS NOT A NEGATIVE — it throws", threw);
  }

  // -- the calendar ----------------------------------------------------------
  {
    const now = new Date("2026-09-05T08:25:00.000Z");
    const window = calendarWindow(now);
    check(
      "the calendar window uses the contract's lead",
      window.to.getTime() - now.getTime() === DETECTOR_THRESHOLDS.calendarLeadMs,
    );
    check(
      "the calendar window uses the contract's trail",
      now.getTime() - window.from.getTime() === DETECTOR_THRESHOLDS.calendarTrailMs,
    );

    const events = parseCalendarEvents(
      JSON.stringify({
        events: [
          {
            id: "evt-1",
            title: "Design review — Portal",
            startsAt: "2026-09-05T08:23:00.000Z",
            endsAt: "2026-09-05T09:00:00.000Z",
            conferenceUrl: "https://meet.example.test/abc?pwd=secret",
          },
          { id: "", title: "broken", startsAt: "", endsAt: "" },
          { title: "no id", startsAt: "2026-09-05T08:00:00.000Z", endsAt: "2026-09-05T08:30:00.000Z" },
        ],
        calendarCount: 2,
        refusedCount: 0,
      }),
    );
    check("a usable event is kept", events.length === 1);
    check("the conference URL is redacted", events[0].conferenceUrl === "https://meet.example.test/abc");
    check("no passcode reaches the signals", !JSON.stringify(events).includes("secret"));
    check("attendees are empty rather than invented", events[0].attendees.length === 0);
    check("an event with no id is dropped", events.every((event) => event.id !== ""));

    let threw = false;
    try {
      parseCalendarEvents("execution error: Not authorized to send Apple events");
    } catch {
      threw = true;
    }
    check("a calendar permission error throws rather than reading as an empty diary", threw);

    // A quiet hour: calendars exist, all enumerated fine, none has an event
    // overlapping the window. This must not be mistaken for a refusal.
    const quietHour = parseCalendarEvents(
      JSON.stringify({ events: [], calendarCount: 2, refusedCount: 0 }),
    );
    check("an empty, fully-enumerable diary is a quiet hour, not a refusal", quietHour.length === 0);

    // The defect this file exists to close: Apple Events to Calendar granted,
    // Calendars data at the write-only tier — every calendar that exists
    // refuses to enumerate its events, and the script still exits cleanly with
    // an empty array. This must throw, not read as "no meetings".
    let refusalThrew = false;
    try {
      parseCalendarEvents(JSON.stringify({ events: [], calendarCount: 2, refusedCount: 2 }));
    } catch {
      refusalThrew = true;
    }
    check(
      "every calendar refusing to enumerate throws rather than reading as no meetings",
      refusalThrew,
    );

    // No calendars at all is not a refusal — there is nothing to correlate
    // against, which is a different statement from "access was denied".
    const noCalendars = parseCalendarEvents(
      JSON.stringify({ events: [], calendarCount: 0, refusedCount: 0 }),
    );
    check("zero calendars is evidence of nothing, not evidence of a refusal", noCalendars.length === 0);

    // A partial refusal — one calendar enumerated fine, another refused —
    // must still read as an ordinary, if incomplete, result: at least one
    // calendar answered, so an empty list here is a real answer.
    const partialRefusal = parseCalendarEvents(
      JSON.stringify({ events: [], calendarCount: 2, refusedCount: 1 }),
    );
    check(
      "one calendar refusing while another answers is not a total refusal",
      partialRefusal.length === 0,
    );
  }
}
