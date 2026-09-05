/**
 * "Never record these apps" has to mean it.
 *
 * Two properties, and they fail in opposite directions:
 *
 *  - a blocked app is invisible to detection, to the panel and to the logs; and
 *  - a *nearly* blocked app — `Zoombini` against an entry of `zoom` — is not
 *    blocked, because a blocklist that silently swallows unrelated meetings is
 *    one a person cannot debug.
 */

import {
  isBlockedApp,
  isBlockedSource,
  isBlockedWindow,
  normalizeAppName,
  redactBlocked,
} from "../src/core/consent/blocklist.ts";

export function runBlocklistChecks(check) {
  check("a name is reduced to its leaf", normalizeAppName("/Applications/zoom.us.app") === "zoom.us");
  check("case is ignored", normalizeAppName("  ZOOM.US  ") === "zoom.us");

  const list = ["zoom", "Therapy Room"];
  check("the plain name is blocked", isBlockedApp("Zoom", list));
  check("the bundle name is blocked", isBlockedApp("zoom.us", list));
  check("the bundle id is blocked", isBlockedApp("us.zoom.xos", list));
  check("the app path is blocked", isBlockedApp("/Applications/zoom.us.app", list));
  check("a two-word entry is blocked", isBlockedApp("Therapy Room", list));
  check("a longer name is NOT blocked", !isBlockedApp("Zoombini", list));
  check("a prefix is NOT blocked", !isBlockedApp("Zoo", list));
  check("an empty candidate is not blocked", !isBlockedApp(undefined, list));
  check("an empty list blocks nothing", !isBlockedApp("zoom", []));
  check("an empty entry does not block everything", !isBlockedApp("Notes", ["", "   "]));
  check("an empty entry does not block every tab", !isBlockedWindow({ app: "Safari", title: "x", url: "https://example.test/a" }, [""]));

  const tab = { app: "Google Chrome", title: "Daily", url: "https://zoom.us/j/123" };
  check("a blocked host in a tab is blocked", isBlockedWindow(tab, list));
  check("an unrelated tab is not blocked", !isBlockedWindow({ app: "Google Chrome", title: "News", url: "https://example.test/a" }, list));
  check("a host suffix entry blocks a subdomain", isBlockedWindow({ app: "Safari", title: "x", url: "https://team.zoom.us/j/1" }, list));
  check("a bare TLD in the list does not block everything", !isBlockedWindow({ app: "Safari", title: "x", url: "https://example.test/a" }, ["test"]));

  check("a blocked source is refused", isBlockedSource({ kind: "zoom", app: "zoom.us" }, list));
  check("a blocked conference URL is refused", isBlockedSource({ kind: "unknown", url: "https://zoom.us/j/9" }, list));
  check("an unblocked source passes", !isBlockedSource({ kind: "meet", app: "Google Chrome", url: "https://meet.example.test/a" }, list));

  // The redaction: a blocked app must not reach detect(), the tooltip or a log.
  const signals = {
    now: "2026-09-05T08:25:00.000Z",
    processes: ["zoom.us", "Google Chrome", "Finder"],
    windows: [
      { app: "zoom.us", title: "Weekly with a name that must never be logged" },
      { app: "Google Chrome", title: "Docs", url: "https://docs.example.test/x" },
      { app: "Google Chrome", title: "Call", url: "https://zoom.us/j/4" },
    ],
    microphoneInUse: true,
    calendarEvents: [
      { id: "e1", title: "Weekly", startsAt: "", endsAt: "", attendees: [], conferenceUrl: "https://zoom.us/j/4" },
      { id: "e2", title: "Standup", startsAt: "", endsAt: "", attendees: [] },
    ],
  };
  const redacted = redactBlocked(signals, list);
  check("a blocked process is removed", !redacted.processes.includes("zoom.us"));
  check("an unblocked process survives", redacted.processes.includes("Google Chrome"));
  check("a blocked window is removed", redacted.windows.every((w) => w.app !== "zoom.us"));
  check("a blocked tab is removed", redacted.windows.every((w) => !(w.url ?? "").includes("zoom.us")));
  check("an unblocked tab survives", redacted.windows.some((w) => (w.url ?? "").includes("docs.example.test")));
  check("a blocked calendar event is removed", redacted.calendarEvents.every((e) => e.id !== "e1"));
  check("an unblocked calendar event survives", redacted.calendarEvents.some((e) => e.id === "e2"));
  check(
    "no blocked window title survives anywhere in the signals",
    !JSON.stringify(redacted).includes("must never be logged"),
  );
  // Deliberately kept: see the comment on `redactBlocked`.
  check("microphoneInUse is not cleared by the blocklist", redacted.microphoneInUse === true);
  check("an empty blocklist returns the signals untouched", redactBlocked(signals, []) === signals);
}
