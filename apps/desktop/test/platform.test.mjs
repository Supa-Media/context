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
 *
 * The first number is high because the redaction is asserted in three places —
 * the window parser, the calendar parser, and "no passcode reaches the
 * signals" — which is the right amount for the one thing in this folder that
 * would leak a meeting passcode into a log.
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
    const stdout = JSON.stringify([
      { app: "zoom.us", title: 'Zoom Meeting — "Design review", Portal', focused: true },
      { app: "Google Chrome", title: "Calendar", url: "https://calendar.example.test/r?tok=secret", focused: false },
      { app: "", title: "orphan" },
      { app: "Notes", title: null },
    ]);
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
      JSON.stringify([
        {
          id: "evt-1",
          title: "Design review — Portal",
          startsAt: "2026-09-05T08:23:00.000Z",
          endsAt: "2026-09-05T09:00:00.000Z",
          conferenceUrl: "https://meet.example.test/abc?pwd=secret",
        },
        { id: "", title: "broken", startsAt: "", endsAt: "" },
        { title: "no id", startsAt: "2026-09-05T08:00:00.000Z", endsAt: "2026-09-05T08:30:00.000Z" },
      ]),
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
  }
}
